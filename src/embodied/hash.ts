import { hashJson } from '../hash.js';
import type { Observation } from './protocol.js';

/**
 * Environment state a replay key is matched on.
 *
 * Covers the Markov state only — pose and gripper — so a policy that reaches an
 * equivalent state at a later step still resolves to the recorded outcome.
 */
export function hashEnvironmentState(observation: Observation): string {
  return hashJson({
    pose: { x: observation.pose.x, y: observation.pose.y, z: observation.pose.z, yaw: observation.pose.yaw },
    gripper: observation.gripper
  });
}

/**
 * Sensor reading a replay key is matched on.
 *
 * `timestamp` and `step` are excluded on purpose: both differ on every run, and
 * including either would make every replay lookup a miss.
 */
export function hashObservation(observation: Observation): string {
  return hashJson({
    environmentId: observation.environmentId,
    environmentVersion: observation.environmentVersion,
    frameId: observation.frameId,
    schemaVersion: observation.schemaVersion,
    pose: { x: observation.pose.x, y: observation.pose.y, z: observation.pose.z, yaw: observation.pose.yaw },
    gripper: observation.gripper,
    objects: observation.objects.map((object) => ({
      id: object.id,
      label: object.label,
      position: [object.position[0], object.position[1], object.position[2]]
    }))
  });
}
