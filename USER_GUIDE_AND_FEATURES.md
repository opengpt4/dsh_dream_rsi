# Dream-RSI Harness Usage and Potential Features

**版本**：0.1  
**更新日期**：2026-09-18  
**適用專案**：Dream-RSI DeepSeek Harness Plugin

## 1. What This Project Is

Dream-RSI Harness is a Cordis plugin for DeepSeek Harness that improves the way an agent organizes model calls, tool calls, exploration, pruning, parallel work, and resource budgets. It does not modify or train the DeepSeek model weights.

The project has two operating loops:

```text
Online task execution
  -> embodied tools and environment feedback
  -> Discovery DAG and cost trace

Offline improvement
  -> immutable Replay Snapshot
  -> deterministic replay and evaluation
  -> safety gate
  -> approval/canary/deployment when implemented
```

The central usage principle is simple: use real execution to collect evidence, use Replay to compare policies cheaply inside the recorded experience boundary, and never deploy a candidate merely because it has a higher aggregate score.

## 2. Capability Status

| Capability | Current status | How to use it |
|---|---|---|
| Cordis plugin entrypoint | Available | Load `apply(ctx, config?)` |
| Configuration validation | Available | Call `resolveDreamRsiConfig()` or pass config to `apply` |
| Perception tool | Available with mock backend | Call `embodied_perceive` |
| High-level action tool | Available with mock backend | Call `embodied_act` |
| World-state query | Available with mock backend | Call `embodied_query_state` |
| Typed action events | Available | Subscribe to `embodied/*` events |
| Discovery storage | Available | Use in-memory or SQLite repository |
| Deterministic Replay | Available | Construct ReplayKey and ReplaySimulator |
| Q/C/P/M evaluation | Available | Call `evaluateReplay()` |
| Task-level data split | Available | Call `splitDiscoveryNodes()` |
| Monotonic gate | Available | Call `evaluateMonotonicGate()` |
| Immutable evaluation snapshot | Available | Call `createEvaluationSnapshot()` |
| Process-isolated evaluator | Available | Call `evaluateReplayIsolated()` |
| Lease-based single writer | Available | Use `SingleWriterLock` |
| Artifact signing | Available for policy artifacts, evaluation reports, and snapshots | `signPolicyArtifact()` / `signEvaluationReport()` / `signEvaluationSnapshot()` and `Ed25519SignatureVerifier` over a ring from `loadKeyRing()`; `persistEvaluationSnapshot()` and `loadEvaluationSnapshot()` |
| Profile/patch integration | Available | Bundle patch shipped (`cordis.patch.yml`, `dsh.bundle.patch`) |
| Candidate policy generation | Available, evaluate-only | Generate through the guard pipeline; no path to the pointer |
| AST/resource/network guard | Static guards available; CPU and network limits come from a host-named runtime | `evaluation.sandboxCommand` / `sandboxArgs`; see `dream_status` |
| Canary deployment and rollback | Available; activation requires a signature verifier | `DeploymentWriter` state machine |
| Tool synthesis | Available, process isolation only | Synthesize, gate, and register via the Dynamic Tool Registry |
| Real simulator adapter | Simulator chosen, bridge and mapping in place, adapter pending | RoboSuite 1.5.2 bridge in `sim/`; the plugin still runs on the mock backend |

## 3. Installation and Verification

The repository is an ESM TypeScript package. The verified runtime baseline is Node.js >=22.5.

```bash
npm ci
npm run typecheck
npm test
```

The current suite contains 521 passing tests. The suite validates implementation invariants; it does not prove cross-task benchmark improvement or physical robot safety.

## 4. Loading the Plugin

The plugin entrypoint is exported from the package root:

```ts
import { apply } from '@opengpt4/dsh-dream-rsi';

apply(ctx);
```

Configuration can be supplied as a partial nested object. Safe defaults keep evolution, automatic deployment, and embodied execution disabled:

```ts
apply(ctx, {
  evolution: {
    enabled: false,
    autoDeploy: false
  },
  embodied: {
    enabled: false
  }
});
```

The configuration layer rejects invalid split ratios, non-positive resource values, empty paths, and `autoDeploy: true` when evolution is disabled. Validation happens before tool registration.

## 5. Working with the Embodied Tools

The current backend is `mock-room-v1`. State is isolated by `session_id`; two sessions do not share pose, step, or gripper state.

### 5.1 Perceive

Use `embodied_perceive` to read the current observation:

```json
{
  "session_id": "demo-session",
  "include_objects": true
}
```

The response contains:

- session and environment identifiers;
- step number;
- agent pose: `x`, `y`, `z`, `yaw`;
- mock objects such as `red-mug` and `wooden-table`;
- an ISO timestamp.

Large sensor payloads are planned to use artifact references rather than being embedded directly in model context.

### 5.2 Act

Use `embodied_act` for an allowlisted high-level action:

```json
{
  "session_id": "demo-session",
  "action_type": "move_relative",
  "parameters": {"dx": 1, "dy": 0, "dz": 0},
  "timeout_ms": 30000
}
```

Available mock actions:

- `move_relative`: add `dx`, `dy`, and `dz` to the current pose;
- `goto`: set `x`, `y`, and `z`;
- `pick`: close the mock gripper;
- `place`: open the mock gripper;
- `open`: open the mock gripper.

Every call returns `success` and an `action_id`. Successful calls also return the new step, pose, gripper state, and message. Unsupported actions return a structured failure and emit an error event.

The current tool observes the DSH cancellation signal and applies a timeout. Full authorization, action leases, capability profiles, session mutexes, rate limiting, and emergency-stop state transitions are specified for the next safety milestone.

### 5.3 Query State

Use `embodied_query_state` with one of the bounded query names:

```json
{
  "session_id": "demo-session",
  "query": "objects"
}
```

Supported queries are `objects`, `pose`, and `gripper`. Arbitrary code and unbounded query expressions are not accepted.

## 6. Typical Current Workflow

### Workflow A: Observe and act

1. Create a stable session identifier.
2. Call `embodied_perceive`.
3. Select an allowlisted high-level action from the observation.
4. Call `embodied_act` with bounded parameters and timeout.
5. Call `embodied_query_state` to verify the resulting state.
6. Associate the tool calls with the task, episode, policy version, and correlation ID in the surrounding runtime.

### Workflow B: Store and replay experience

1. Record each observation/action/result as a `DiscoveryNode`.
2. Use an idempotency key so retries do not duplicate nodes.
3. Create a canonical ReplayKey from environment version, state hash, action type, normalized parameters, and observation hash.
4. Build an immutable evaluation snapshot.
5. Run the deterministic Replay Simulator.
6. Treat known transitions as replay hits and unknown transitions as boundary misses.
7. Evaluate quality, cost, parallel efficiency, and miss rate separately.

### Workflow C: Compare current and candidate policies

1. Freeze the same snapshot for both policies.
2. Keep task membership fixed across train, validation, and holdout.
3. Run the current policy and candidate policy over the same case set.
4. Reject incomplete case sets.
5. Apply quality pass ratio, minimum improvement, miss-rate, and budget gates.
6. Store an evaluation report with snapshot ID, policy artifact ID, evaluator version, source hash, and configuration hash.
7. Only then consider approval and canary deployment.

At present, candidate generation and deployment are planned rather than fully available. The safe default is evaluate-only.

## 7. Operational Safety Rules

Use these rules when integrating the project:

- Keep DeepSeek credentials in the host secret provider; never include them in Discovery nodes or candidate inputs.
- Keep Replay read-only and free of LLM calls, live tool calls, network calls, and sandbox execution.
- Never use `nodeId` alone as a replay key.
- Do not treat a replay hit as evidence about an unobserved environment transition.
- Keep policy, tool, snapshot, evaluator, and report artifacts immutable after publication.
- Keep automatic deployment disabled until AST, dependency, resource, network, approval, canary, and rollback controls are implemented.
- Use only high-level embodied actions; do not expose raw motor commands through this plugin.
- Use separate session identifiers for separate environments or users.
- Treat the current child-process evaluator as a process boundary, not a complete security sandbox.
- Record correlation IDs so task, action, Discovery, evaluation, and deployment events can be joined.

## 8. Potential Features

The following features are part of the intended product direction, but are not all implemented in the current repository.

### 8.1 Harness and runtime features

- DeepSeek LLM adapter with model, temperature, token, timeout, retry, and cost accounting.
- `dream status`, `dream evaluate`, `dream evolve`, `dream pause`, and `dream resume` commands.
- Policy version list, show, approval, rollback, and deployment audit history.
- Shadow mode in which a candidate observes production tasks without controlling actions.
- Canary mode with automatic health thresholds and bounded rollout percentage.
- Online/offline worker separation so evolution failures cannot stop task execution.

### 8.2 Replay and learning features

- Replay snapshot creation from consistent SQLite transactions.
- Counterfactual branch enumeration across alternative historical actions.
- Replay coverage metrics and explicit boundary maps.
- Candidate comparison by task family rather than only global average.
- Confidence intervals, minimum sample requirements, and statistical reports.
- Cross-task transfer evaluation to measure how search topology affects policy reuse.
- Optional content-only snapshot deduplication in addition to timestamped snapshot identity.

### 8.3 Evolution features

- Evolution Agent that edits scheduling and orchestration code through the Harness LLM facade.
- AST and import allowlists that constrain candidate source.
- Resource, network, filesystem, dependency, and output guards.
- Reproducible candidate builds with source hashes and dependency manifests.
- Tool Synthesizer that extracts repeated successful subgraphs into reviewed tools.
- Dynamic Tool Registry with versioning, approval, disable, and rollback.
- Human-readable diagnostics without automatically turning semantic summaries into pruning rules.

### 8.4 Embodied AI features

- Real simulator adapter such as a selected digital environment backend.
- Capability profiles for sensors, actions, coordinate frames, speed limits, and risk levels.
- Action state machine with authorization, lease, mutex, cancellation, timeout, and emergency stop.
- Artifact references for RGB, depth, point clouds, audio, and other large observations.
- World-model queries for room graphs, objects, navigation nodes, and state history.
- Human confirmation workflow for high-risk actions.
- Hardware adapters behind the environment interface, without exposing raw motor commands to policy.

### 8.5 Operations and governance features

- Signed policy, tool, snapshot, evaluation, and deployment artifacts.
- OS/container sandbox for untrusted candidate code with no secrets and restricted network.
- CPU, memory, process-count, disk, output, and wall-clock budgets.
- Content retention, deletion, encryption, redaction, and access-control policies.
- Failure injection and recovery reports for worker crashes, stale leases, corrupted artifacts, provider outages, and rollback.
- Dashboards for Q/C/P/M/S, replay coverage, action failures, cost, latency, approvals, and rollbacks.

## 9. Suggested Adoption Stages

### Stage 1: Local development

Use the mock backend, run the 24-test suite, inspect tool outputs, and verify lifecycle disposal. Keep all evolution and deployment flags disabled.

### Stage 2: Offline evaluation

Populate Discovery nodes from controlled task fixtures, create immutable snapshots, replay historical transitions, and compare policies without live LLM or environment access.

### Stage 3: Evaluate-only evolution

Add candidate generation and guards, but only produce reports. Require matching case sets, holdout evaluation, and manual inspection of every candidate.

### Stage 4: Shadow and canary

Run approved candidates in shadow mode, then expose them to a small canary workload. Monitor quality, cost, latency, miss rate, and action failures.

### Stage 5: Controlled production

Policy artifact signing, approval, rollback, audit, and retention are in place. Sandboxing and failure recovery are demonstrated to the extent the mock environment allows; a real pilot still needs the simulator and OS-level confinement.

## 10. Known Limitations

- The current environment backend is a mock implementation, not a physical robot or physics simulator.
- The current evaluator process is not a full OS/container sandbox.
- Candidate policy generation, AST/resource guards, tool synthesis, canary deployment, and rollback are planned.
- Replay cannot predict behavior outside the recorded history boundary.
- The configured scoring weights are domain-dependent and are not universal scientific constants.
- Current automated tests establish software invariants, not benchmark superiority or physical safety.

## 11. Related Documents

- [README.md](README.md): repository entrypoint and current baseline
- [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md): functional requirements
- [PROJECT_PLAN.md](PROJECT_PLAN.md): phased implementation plan
- [DETAILED_DESIGN_SPEC.md](DETAILED_DESIGN_SPEC.md): implementation contracts
- [TECHNICAL_PAPER.md](TECHNICAL_PAPER.md): scientific-style architecture paper
- [TODO.md](TODO.md): prioritized implementation checklist
- [BASELINE.md](BASELINE.md): verified runtime and API baseline
