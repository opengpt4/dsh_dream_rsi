"""Line-delimited JSON bridge to a RoboSuite environment.

The bridge is deliberately thin: it owns the simulator session and reports raw
RoboSuite state. Turning that into the plugin's data model is the TypeScript
adapter's job, so the mapping is covered by the test suite that runs it rather
than by Python nothing asserts.

One request per line on stdin, one response per line on stdout. A failed command
answers with {"error": "..."} and leaves the session usable; a failed *import*
exits non-zero so the adapter can tell "no simulator here" from "bad command".

Run it directly to see the protocol:

    python sim/robosuite_bridge.py <<< '{"command":"capability"}'
"""

import json
import os
import sys

# RoboSuite renders offscreen through MuJoCo; on macOS the working combination is
# glfw. Set before importing robosuite so the choice is in force at import time.
os.environ.setdefault("MUJOCO_GL", "glfw")

try:
    import numpy as np  # noqa: F401  (robosuite needs it; imported for the error path)
    import robosuite
    from robosuite import load_composite_controller_config
except Exception as error:  # pragma: no cover - exercised by the missing-venv test
    sys.stderr.write(f"robosuite is not importable: {error}\n")
    raise SystemExit(3)


#: Environments this bridge will build, with the observations each one exposes as
#: movable objects. Anything else is refused rather than defaulted.
ENVIRONMENTS = {
    "Lift": {"objects": ["cube"]},
    "Stack": {"objects": ["cube", "cube_b"]},
}


class Session:
    """One RoboSuite environment, keyed by the plugin's session id."""

    def __init__(self, environment, seed):
        if environment not in ENVIRONMENTS:
            raise ValueError(
                f"unknown environment {environment}; this bridge builds "
                + ", ".join(sorted(ENVIRONMENTS))
            )
        self.environment = environment
        # 1.5.2 renamed the loader: `load_controller_config` is gone and the
        # default is a composite configuration per robot.
        controller = load_composite_controller_config(robot="Panda")
        self.env = robosuite.make(
            environment,
            robots="Panda",
            controller_configs=controller,
            has_renderer=False,
            has_offscreen_renderer=False,
            use_camera_obs=False,
            reward_shaping=True,
            control_freq=20,
            ignore_done=True,
        )
        # RoboSuite 1.5.2 exposes no seed API (`env.seed` is None); what it has is
        # `deterministic_reset`, which turns placement randomisation off. The
        # requested seed is therefore recorded but not applied: see the caveat in
        # BASELINE.md, and TODO item 152 for what has to replace it.
        self.requested_seed = seed
        self.env.deterministic_reset = True
        self.env.reset()
        self.step = 0

    def close(self):
        try:
            self.env.close()
        except Exception:
            pass


SESSIONS = {}


def _quat_to_yaw(quaternion):
    """Yaw about Z from RoboSuite's (x, y, z, w) quaternion."""
    x, y, z, w = (float(value) for value in quaternion)
    return float(np.arctan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z)))


def _state(session):
    observation = session.env._get_observations()
    pose = observation["robot0_eef_pos"]
    quaternion = observation["robot0_eef_quat"]
    gripper_qpos = observation["robot0_gripper_qpos"]
    # Panda's fingers: positive separation is open. The threshold is a declared
    # convention, not a guess: 0.02 m is under one finger's travel at rest.
    gripper = "open" if float(np.sum(np.abs(gripper_qpos))) > 0.02 else "closed"

    objects = {}
    for name in ENVIRONMENTS[session.environment]["objects"]:
        key = f"{name}_pos"
        if key in observation:
            objects[name] = [float(value) for value in observation[key]]

    return {
        "step": session.step,
        "pose": {
            "x": float(pose[0]),
            "y": float(pose[1]),
            "z": float(pose[2]),
            "yaw": _quat_to_yaw(quaternion),
        },
        "gripper": gripper,
        "objects": objects,
        "success": bool(session.env._check_success()),
        "reward": float(session.env.reward()),
    }


def _action_vector(session, action_type, parameters):
    """Map a plugin action onto RoboSuite's OSC_POSE control vector.

    RoboSuite actions are `[dx, dy, dz, drx, dry, drz, gripper]` in metres and
    radians, with the gripper as -1 (open) or +1 (close). The plugin's actions
    are high-level, so each one becomes a short sequence of these inside
    `execute`, not a single control step.
    """
    state = session.env._get_observations()
    current = np.asarray(state["robot0_eef_pos"], dtype=float)
    gripper = -1.0

    if action_type == "move_relative":
        delta = np.array(
            [
                float(parameters.get("dx", 0.0)),
                float(parameters.get("dy", 0.0)),
                float(parameters.get("dz", 0.0)),
            ]
        )
        target = current + delta
    elif action_type == "goto":
        target = np.array(
            [
                float(parameters["x"]),
                float(parameters["y"]),
                float(parameters["z"]),
            ]
        )
    elif action_type == "pick":
        target = current
        gripper = 1.0
    elif action_type == "place":
        target = np.array(
            [
                float(parameters["x"]),
                float(parameters["y"]),
                float(parameters["z"]),
            ]
        )
    elif action_type == "open":
        target = current
    else:
        raise ValueError(f"unsupported action {action_type}")

    return target, gripper


#: OSC_POSE's position output limit, read from the controller rather than assumed:
#: the action it takes is normalised to this, so a delta in metres has to be
#: divided by it. Sending metres directly asked for 0.02 of a 0.05 m range — about
#: a millimetre of travel per step, which is why an action never converged.
POSITION_LIMIT_M = 0.05


def _normalized(delta):
    """The control input that moves `delta` metres this step, clipped to range."""
    return np.clip(delta / POSITION_LIMIT_M, -1.0, 1.0)


def _step_towards(session, target, gripper, steps, tolerance=0.01):
    """Drive the end effector toward `target` for at most `steps` control steps."""
    for _ in range(steps):
        state = session.env._get_observations()
        current = np.asarray(state["robot0_eef_pos"], dtype=float)
        delta = target - current
        distance = float(np.linalg.norm(delta))
        if distance < tolerance:
            if gripper <= 0:
                # Arrived, and there is no grasp to form: stop here rather than
                # stepping the rest of the budget holding position.
                break
            # A grasp still needs the remaining steps for the fingers to close.
            delta = np.zeros(3)
        # Orientation is held, not commanded: passing the measured orientation as
        # the rotation *delta* asked for a large rotation, which is why a
        # `move_relative` with dy 0 still moved y — the position delta was then
        # applied in a frame that had turned. Holding it keeps the requested axes.
        action = np.concatenate([_normalized(delta), np.zeros(3), [gripper]])
        session.env.step(action)
        session.step += 1
    # Returns nothing: the caller re-reads state, which is the only thing that
    # can say what actually happened.


def _execute(session, action_type, parameters, steps):
    target, gripper = _action_vector(session, action_type, parameters)
    _step_towards(session, target, gripper, steps)
    state = _state(session)
    if action_type == "pick":
        state["status"] = "completed" if state["success"] or state["gripper"] == "closed" else "failed"
    elif action_type in ("goto", "move_relative", "place"):
        current = np.asarray(session.env._get_observations()["robot0_eef_pos"], dtype=float)
        state["status"] = "completed" if float(np.linalg.norm(target - current)) < 0.05 else "timeout"
    else:
        state["status"] = "completed"
    return state


def handle(request):
    command = request.get("command")
    if command == "capability":
        return {
            "robosuite": robosuite.__version__,
            "environments": sorted(ENVIRONMENTS),
            "frame": "mujoco-world",
        }
    if command == "reset":
        session_id = request["sessionId"]
        if session_id in SESSIONS:
            SESSIONS[session_id].close()
        session = Session(request["environment"], int(request.get("seed", 0)))
        SESSIONS[session_id] = session
        return {
            "sessionId": session_id,
            "seedApplied": False,
            "state": _state(session),
        }
    if command == "observe":
        return {"state": _state(SESSIONS[request["sessionId"]])}
    if command == "execute":
        session = SESSIONS[request["sessionId"]]
        return {
            "state": _execute(
                session,
                request["actionType"],
                request.get("parameters") or {},
                int(request.get("steps", 20)),
            )
        }
    if command == "emergency_stop":
        session = SESSIONS.pop(request["sessionId"], None)
        if session is not None:
            session.close()
        return {"stopped": True}
    if command == "release_all":
        for session in SESSIONS.values():
            session.close()
        SESSIONS.clear()
        return {"released": True}
    if command == "shutdown":
        return {"shutdown": True}
    raise ValueError(f"unknown command {command}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            response = handle(request)
        except Exception as error:
            response = {"error": f"{type(error).__name__}: {error}"}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()
        if isinstance(response, dict) and response.get("shutdown"):
            break


if __name__ == "__main__":
    main()
