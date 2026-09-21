# Dream-RSI DeepSeek Harness Plugin Detailed Design Specification

**版本**：0.1
**日期**：2026-09-18
**狀態**：Implementation-ready design
**Related**：[PROJECT_PLAN.md](PROJECT_PLAN.md)、[FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md)、[BASELINE.md](BASELINE.md)

## 1. Design Intent

本設計把 Dream-RSI 落成一個 Cordis plugin 與一組可獨立測試的 core modules。設計採取兩個邊界：

1. `dream-rsi-core`：不依賴特定 LLM、simulator 或硬體，負責 Discovery、Replay、Evaluation、Evolution contract 與 artifact integrity。
2. `dsh-embodied`：負責 DSH/Cordis adapter、session backend、perceive/act/query-state tools、typed events 與 action safety。

底層 model 是 frozen provider。Evolution Agent 可以修改的只有 policy orchestration 與受審核 tool artifact；不能修改 model weights、evaluation data、deployment registry 或 secrets。

### 1.1 Implementation status notation

- **Implemented**：目前 repository 已有程式與測試。
- **Specified**：本文件定義 contract，但 repository 尚未完成。
- **Deferred**：需要外部 DSH contract、sandbox、simulator 或產品決策後才實作。

## 2. System Context

```mermaid
flowchart LR
  User[User task] --> DSH[DeepSeek Harness]
  DSH --> Plugin[Cordis Plugin]
  Plugin --> Policy[Current Policy]
  Plugin --> LLM[Harness LLM Adapter]
  Plugin --> Tools[Tool Runtime]
  Tools --> Env[Embodied Backend]
  Plugin --> Store[Discovery Store]
  Store --> Snap[Immutable Replay Snapshot]
  Snap --> Replay[Deterministic Replay Simulator]
  Replay --> Eval[Isolated Evaluator]
  Eval --> Gate[Safety and Monotonic Gate]
  Gate --> Deploy[Approval / Canary / Deployment]
  Deploy --> Policy
```

Online execution and offline evolution are separate failure domains:

- Online task path must continue when evolution fails.
- Offline path must never call the online LLM or external environment during Replay.
- Deployment changes current policy only after artifact and gate checks.

## 3. Runtime Boundaries

### 3.1 Cordis adapter

The adapter owns all Cordis-specific operations:

- `apply(ctx)` entrypoint.
- `ctx.effect()` reversible registration scope.
- tool registration and unregistration.
- service/event/command registration when the pinned DSH contract is confirmed.
- profile and `cordis.patch.yml` compatibility.

Core modules receive plain TypeScript interfaces and must not import Cordis types.

#### Enforced boundaries

`test/architecture.test.mjs` checks the import graph rather than asserting the boundary in prose:

| Boundary | Check |
|---|---|
| Simulator SDK | `embodied/backend.ts` is imported only by `embodied/mock-adapter.ts`, `runtime.ts`, and the package entry |
| Environment protocol | `embodied/protocol.ts` depends on nothing but `discovery/models.ts` |
| Embodied tools | every tool takes `EnvironmentAdapter`, never the SDK |
| Policy and replay | never import the environment layer |
| Registry | never imports the environment layer |
| Cordis registration | only `adapter/cordis.ts` calls `ctx.tools.register` or `ctx.effect` |
| Cordis services | every non-core `ctx.<name>` the adapter reads is declared in the plugin's `inject` |

`test/real-cordis-mount.test.mjs` mounts the plugin on an actual `Context` rather than a hand-built object, so the proxy that enforces `inject` is exercised. The hand-built context in `test/adapter-compat.test.mjs` cannot catch a missing declaration: it has a `tools` property, so registration succeeds whatever `inject` says.
| Module reachability | every source module is reachable from the entry or listed as a path-spawned entry point |
| Mounting contract | the manifest patch path resolves, the patch parses to one row, and that row's id and name agree with the plugin and the package |

The reachability check catches a module that was written and never wired up. Two modules are legitimately unreachable and are declared as such: `index.ts` is the root, and `evolution/evaluator-worker.ts` is spawned by path rather than imported.

The Cordis check is deliberately narrow. Taking a `Context` to emit an event does not couple a module to the loader; calling the registration API does, because that is what must be reversible on unload. A tool registered outside the adapter's disposer chain would never be unregistered, which is why the one such helper that existed was removed rather than left unused.

### 3.2 Harness adapter

```ts
export interface LlmRequest {
  model: string;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  correlationId: string;
}

export interface LlmResponse {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: 'stop' | 'length' | 'error';
}

export interface HarnessLlm {
  invoke(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

export interface HarnessToolRuntime {
  execute(name: string, args: JsonObject, context: ToolContext): Promise<JsonValue>;
}

export interface HarnessAdapter {
  readonly llm: HarnessLlm;
  readonly tools: HarnessToolRuntime;
  readonly sourceVersion: string;
}
```

All model requests pass through `HarnessLlm.invoke`. The adapter records request/response hashes, token usage, latency, retry count, provider error class and correlation ID. API credentials are resolved by the host secret provider and never passed into candidate code.

`createRecordingLlm` (`src/evolution/llm-recorder.ts`) is that recording adapter. It holds **hashes, not bodies**: an observability log that keeps the prompt and response is a second copy of the data it exists to describe, and the prompt can carry candidate and observation text. Retries are bounded by `maxAttempts` and counted; an exhausted call throws with the provider error class and a record whose `responseHash` is null. Given a `MetricsSink` it emits per-task `llm.inputTokens`, `llm.outputTokens`, `llm.latencyMs`, `llm.retry`, and `llm.failure`.

### 3.3 Environment adapter

```ts
export interface EnvironmentAdapter {
  observe(request: ObserveRequest): Promise<Observation>;
  availableActions(): Promise<readonly EmbodiedActionType[]>;
  execute(request: ActionRequest, signal?: AbortSignal): Promise<ActionResult>;
  emergencyStop(sessionId: string): Promise<void>;
  reset(sessionId: string): void;
}
```

The adapter is the only component permitted to know a simulator or hardware SDK. Core policy sees action schemas and structured observations, not raw motor channels. Full request/result shapes are in §5.2; `execute` resolves to a terminal result rather than throwing.

`capability()` is part of the contract: every backend declares the sensors, actions, coordinate frames, and limits it supports, and a capability absent from that declaration is denied rather than defaulted. The declaration types live in `src/embodied/capability.ts` and enforcement in `src/safety/capability.ts`, so a backend declares its profile and safety checks it — the reverse direction would have the environment layer depend on the policy that constrains it.

## 4. Cordis Plugin Lifecycle

### 4.1 Apply

`apply(ctx)` creates a backend factory and registers embodied tools inside one reversible `ctx.effect` scope. The setup function returns a disposer that unregisters in reverse order. Current implementation covers this tool lifecycle with a mock backend.

Target setup sequence:

1. Validate configuration and capability profile.
2. Resolve storage and artifact directories.
3. Construct service facades.
4. Register typed events.
5. Register tools and read-only commands.
6. Register disposal for workers, stores, backend sessions and tools.

A setup failure must dispose any registrations already created, then fail startup with an actionable error. No asynchronous worker may survive dispose.

### 4.2 Ready and dispose

`ready` verifies storage schema, current policy artifact, evaluator worker availability and backend capability profile. `dispose` cancels evolution jobs, waits for bounded shutdown, closes SQLite/artifact handles, resets session backends and unregisters all effects.

Implemented as `verifyReadiness` (`src/readiness.ts`), surfaced through `dream_status` when the tool is constructed with a runtime. The tool previously accepted a runtime and dropped it, so readiness lived on the function and never reached the output a model reads; `noUnusedParameters` now makes that mistake a compile error. Each check reports `ready`, `not-ready`, or `not-probed` rather than a boolean, because opening the store creates the database file and the status tool is documented as side-effect free: storage is left `not-probed` there and probed only when a caller asks. A `not-probed` check does not make the report claim readiness.

`dispose` releases adapter sessions and guard latches before closing storage. Releasing sessions is not housekeeping: a backend that keeps them past unload leaves a real environment holding whatever pose and gripper the last episode left it in. Guard latches go with them, because the sessions a guard knew about belong to a runtime that no longer exists.

### 4.3 Configuration defaults

```ts
export interface DreamRsiConfig {
  enabled: boolean;
  storage: { sqlitePath: string; artifactDir: string };
  runtime: { maxWorkers: number; taskTimeoutMs: number };
  replay: { maxNodes: number; missRateMax: number; keySchemaVersion: number };
  evaluation: {
    trainRatio: number;
    validationRatio: number;
    holdoutRatio: number;
    minimumHoldoutSamples: number;
    timeoutMs: number;
  };
  operations: { evolutionLock: string; deploymentLock: string; jobLeaseMs: number };
  evolution: { enabled: boolean; maxCandidates: number; autoDeploy: boolean; minimumImprovement: number };
  embodied: { enabled: boolean; requireConfirmation: boolean; actionLeaseMs: number; maxActionsPerMinute: number };
}
```

Defaults: `enabled=true`, `evolution.enabled=false`, `evolution.autoDeploy=false`, `embodied.enabled=false`, evaluator isolation required. Ratio validation requires `train + validation + holdout = 1` and each ratio > 0.

`embodied.allowActions` narrows the declared action set. Narrowing only: an action the backend's profile does not declare cannot be granted by configuration, so config can tighten a deployment but never widen it. The effective profile is exposed as `runtime.capabilityProfile`, and readiness reports that rather than the declared one, because once configuration narrows them they differ.

## 5. Online Execution Design

### 5.1 Task and episode

```ts
export interface ResourceBudget {
  maxSteps: number;
  wallClockMs: number;
}

export interface Task {
  taskId: string;
  goal: string;
  environmentId: string;
  policyVersion: string;
  budget: ResourceBudget;
  metadata: JsonObject;
}

export type EpisodeStatus =
  | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout' | 'emergency_stop';

export interface Episode {
  episodeId: string;
  taskId: string;
  sessionId: string;
  environmentId: string;
  policyVersion: string;
  step: number;
  status: EpisodeStatus;
  correlationId: string;
  startedAt: string;
  endedAt?: string;
}
```

Every task receives a policy version at start. A later deployment cannot mutate the policy used by an already-running episode unless the host explicitly supports a version boundary.

`emergency_stop` is a terminal episode status distinct from `cancelled`: an operator stop forbids automatic retry. `wallClockMs` is enforced between steps and clamps each action deadline; `maxSteps` bounds recorded nodes.

### 5.2 Environment protocol

The contract in `src/embodied/protocol.ts`. Adapters translate a simulator SDK into these types; core policy never sees the SDK.

```ts
export interface Observation {
  sessionId: string;
  environmentId: string;
  environmentVersion: string;
  frameId: string;
  step: number;
  pose: Pose;
  gripper: GripperState;
  objects: ObservedObject[];
  schemaVersion: number;
  timestamp: string;
}

export interface ActionRequest {
  actionId: string;
  sessionId: string;
  taskId: string;
  episodeId: string;
  correlationId: string;
  actionType: EmbodiedActionType;
  parameters: JsonObject;
  timeoutMs: number;
  requestedAt: string;
}

export type ActionStatus = 'completed' | 'failed' | 'timeout' | 'cancelled' | 'emergency_stop';

export interface ActionResult {
  actionId: string;
  status: ActionStatus;
  step: number;
  pose: Pose;
  gripper: GripperState;
  message: string;
  execTimeMs: number;
  completedAt: string;
  error?: string;
}

export interface EnvironmentAdapter {
  observe(request: ObserveRequest): Promise<Observation>;
  availableActions(): Promise<readonly EmbodiedActionType[]>;
  execute(request: ActionRequest, signal?: AbortSignal): Promise<ActionResult>;
  emergencyStop(sessionId: string): Promise<void>;
  reset(sessionId: string): void;
}
```

`execute` resolves to a terminal `ActionResult`; it does not throw for an action-level failure, timeout, cancellation, or stop. The caller records these as outcomes, so a rejected promise means the adapter itself is unusable. A session stopped through `emergencyStop` stays latched until `reset`.

### 5.3 Replay hashes

A `DiscoveryNode` carries two hashes, both computed from the pre-action observation:

| Hash | Covers | Excludes |
|---|---|---|
| `stateHash` | `pose`, `gripper` | `step`, `timestamp`, `objects` |
| `observationHash` | `environmentId`, `environmentVersion`, `frameId`, `schemaVersion`, `pose`, `gripper`, `objects` | `step`, `timestamp` |

Both exclusions are load-bearing: `step` and `timestamp` differ on every run, so covering either would make every replay lookup a miss. `stateHash` is the Markov state, so a policy reaching an equivalent state at a later step still resolves to the recorded outcome.

### 5.4 Episode pipeline

`src/tasks/runner.ts` records exactly one Discovery node per step — including failed, timed-out, and cancelled attempts, because a negative result is evidence and dropping it would make the recorded tree disagree with what the environment did.

`src/tasks/pipeline.ts` then runs `runEpisode -> createEvaluationSnapshot -> replay -> evaluateReplay` and applies the runtime's derived ceilings (`replay.maxNodes`, `replay.missRateMax`, `evaluation.timeoutMs`, `evaluation.minimumHoldoutSamples`).

Replaying an episode's own recorded decisions is a **determinism check, not generalization evidence**: every replayed decision was recorded from the state it is replayed against, so a clean run only proves the replay key is stable and the state index resolves. Generalization requires holdout tasks the policy never saw — the multi-task benchmark, which is still an open release blocker.

### 5.5 Embodied tools

#### `embodied_perceive`

Input: `session_id`, optional `sensor_types`, `include_objects`, `include_pose`, `artifact_threshold_bytes`.

Implemented: `sensor_types`, `include_objects`, and `include_pose`. A sensor absent from the declared profile is refused, so a caller cannot read a channel the backend never claimed to have. `artifact_threshold_bytes` is not implemented because no adapter yet produces a payload large enough to externalise; the artifact store and its retention policy are in place for when one does.

Output: compact text/JSON observation, object references, pose, timestamp, coordinate-frame ID, schema version and artifact references. Large RGB/depth/point-cloud payloads are stored externally with checksum and retention metadata. The frame ID and schema version are always reported, whichever sensors were read: without the frame a pose is an ambiguous triple of numbers, and without the version a consumer cannot tell which schema it is parsing.

#### `embodied_act`

Input: `session_id`, `action_type`, `parameters`, optional `timeout_ms`, `confirmation_token`.

Processing:

1. Observe, to learn the coordinate frame the action will be expressed in.
2. Hand the action to `ActionGuard`, which validates the capability profile, confirmation, session mutex, idempotency key and rate limit, then holds the action lease (§5.6).
3. Emit `embodied/action-started`.
4. Execute through `EnvironmentAdapter` with the guard's deadline and abort signal.
5. Emit completed, failed, cancelled, timeout or emergency-stop event.

A rejected action never reaches the adapter and returns `success: false` with a `rejection_code`.

Output contains `success`, `action_id`, the state-machine `state`, the terminal `status`, and either `result` or `error`. `state` and `status` are distinct: `state` is where the action ended in the state machine, `status` is the backend outcome.

#### `embodied_query_state`

Input is a bounded query enum or approved DSL. The tool may return room graph, objects, navigation nodes and last state reference. It must reject arbitrary code, unbounded graph traversal and unauthorized session access.

### 5.6 Action state machine

```mermaid
stateDiagram-v2
  [*] --> REQUESTED
  REQUESTED --> AUTHORIZED: capability + permission pass
  REQUESTED --> FAILED: invalid/rejected
  AUTHORIZED --> EXECUTING: lease acquired
  AUTHORIZED --> CANCELLED: cancelled before start
  EXECUTING --> COMPLETED: backend success
  EXECUTING --> FAILED: backend error
  EXECUTING --> TIMEOUT: deadline exceeded
  EXECUTING --> CANCELLED: abort signal
  EXECUTING --> EMERGENCY_STOP: emergency stop
  TIMEOUT --> [*]
  CANCELLED --> [*]
  EMERGENCY_STOP --> [*]
  COMPLETED --> [*]
  FAILED --> [*]
```

After `EMERGENCY_STOP`, automatic retry is forbidden. All terminal transitions are idempotent and carry the same `actionId`.

Implemented in `src/safety/action-state.ts` as an explicit transition table; a transition absent from the table throws rather than silently succeeding.

#### Capability profile

`src/safety/capability.ts`. Every embodied backend declares one, and a capability absent from it is denied rather than defaulted. `checkCapability` rejects, in order: an undeclared action, an undeclared coordinate frame, a parameter the action does not accept, a numeric parameter beyond `maxNumericMagnitude`, and a deadline beyond `maxDurationMs`.

```ts
export interface CapabilityProfile {
  profileId: string;
  sensors: string[];
  coordinateFrames: string[];
  actions: Partial<Record<EmbodiedActionType, ActionCapability>>;
}

export interface ActionCapability {
  actionType: EmbodiedActionType;
  risk: 'safe' | 'guarded' | 'high';
  requiresConfirmation: boolean;
  limits: { allowedParameters: string[]; maxNumericMagnitude: number; maxDurationMs: number };
}
```

#### Action guard

`src/safety/action-guard.ts` owns one session's safety state and is the only path to a backend when `RunEpisodeOptions.guard` is set. `execute` runs, in order:

1. **Stop latch.** Checked *before* the idempotency lookup: after an operator stop, a previously recorded result must not be replayed as a successful retry.
2. **Idempotency.** A key that was already authorized resolves to its recorded outcome without reaching the backend.
3. **Session mutex.** A second action on a busy session is refused, not queued.
4. **Capability profile.** Any rejection ends the action at `REQUESTED -> FAILED`.
5. **Confirmation.** Required when both the capability and `embodied.requireConfirmation` say so. With no host approval hook the action is denied, so approval is opt-in and never implied.
6. **Rate limit.** A sliding `RATE_WINDOW_MS` window per session.
7. **Dispatch** on `AUTHORIZED -> EXECUTING`, holding a lease for `embodied.actionLeaseMs`.

Rejections are returned rather than thrown, and are **not** cached under the idempotency key: a rate-limited or busy rejection is re-evaluated on the next attempt, while an authorized action never runs twice.

The guard owns the two session-level deadlines, so they override whatever the aborted backend call reports: a stop in flight settles as `EMERGENCY_STOP` and a held lease settles as `TIMEOUT`, regardless of the adapter returning `cancelled`.

`emergencyStop` latches the session and aborts any action in flight. The latch outlives the episode: `runEpisode` latches the guard when an episode ends in `emergency_stop`, so a later episode reusing the session is refused. `releaseSession` clears it, and re-arming a stopped session is an explicit operator act.

## 6. Discovery Data Model

### 6.1 Discovery node

```ts
export interface DiscoveryNode {
  nodeId: string;
  taskId: string;
  parentId: string | null;
  policyVersion: string;
  environmentVersion: string;
  stateHash: string;
  observationHash: string;
  actionType: string;
  actionParams: JsonObject;
  result: JsonValue;
  score: number;
  tokenCost: number;
  execTimeMs: number;
  criticalPathMs?: number;
  sessionId?: string;
  episodeId?: string;
  episodeStep?: number;
  correlationId?: string;
  idempotencyKey: string;
  schemaVersion: number;
  createdAt: string;
}
```

The repository must enforce unique `idempotencyKey`, preserve the first accepted node for retries, and provide indexes for `taskId`, `parentId`, `policyVersion`, `environmentVersion` and `createdAt`.

### 6.2 Artifact reference

```ts
export interface ArtifactMetadata {
  /** Lowercase SHA-256 of the stored bytes, and the name the blob is filed under. */
  artifactId: string;
  kind: 'observation' | 'llm-response' | 'sandbox-output' | 'policy' | 'tool' | 'evaluation-report';
  mediaType: string;
  schemaVersion: number;
  byteLength: number;
  createdAt: string;
  retentionUntil: string | null;
  deletedAt: string | null;
}
```

Database rows contain references, not large binary payloads.

`PolicyArtifact.sourceRef` is an `ArtifactRef` pointing at the stored source. It is deliberately **not** part of the artifact id: the id covers what the artifact is, and `sourceSha256` already binds the content. A reference is a location, and two records of the same policy must share one identity regardless of where the bytes live. `verifyPolicyArtifactSource` therefore checks separately that the referenced bytes hash to `sourceSha256`.

Because storage is content-addressed, `artifactId` **is** the SHA-256 of the bytes: a separate `contentSha256` field would be the same value twice, and a stored `uri` is derivable from the id. `verify(artifactId)` re-hashes the blob on disk rather than trusting the index, and distinguishes `unknown`, `deleted`, `missing_blob`, and `checksum_mismatch`. `assertArtifactsVerified` fails closed before evaluation; deployment must call it rather than re-implement the check.

Retention and deletion are recorded in metadata, never by rewriting or truncating a blob. `pruneExpired` deletes artifacts past `retentionUntil` and only ever runs when called: a retention policy that fires on its own is an audit-trail hazard.

## 7. Replay Design

### 7.1 Canonical ReplayKey

Replay lookup key is the canonical JSON encoding of:

```ts
export interface ReplayKeyInput {
  environmentVersion: string;
  stateHash: string;
  actionType: string;
  normalizedActionParams: JsonValue;
  observationHash: string;
}
```

Object keys are sorted recursively; arrays preserve order; numbers and strings use one canonical JSON representation. The key schema version is included in snapshot metadata. `nodeId` is never sufficient for a replay hit.

### 7.2 Snapshot

`createEvaluationSnapshot(nodes, splitConfig, createdAt)`:

1. Clone input nodes.
2. Freeze nested structures.
3. Assign task-level train/validation/holdout membership using deterministic SHA-256.
4. Serialize schema version, creation time and splits.
5. Hash the serialized content as `snapshotId` — `schemaVersion` and `splits` only. `createdAt` is recorded on the snapshot but excluded from the id, so two snapshots of the identical tree share an id and the id is a content address. Node-level `createdAt` values are part of the content, so the identity still covers when the work happened.
6. Return an immutable snapshot.

Evaluation stores the snapshot ID and content hash. A snapshot is never edited in place.

The node list comes from `DiscoveryStore.readAll()`, which a database-backed store serves under a single deferred transaction. Reading the tree with more than one statement under read-committed isolation can straddle a concurrent write and yield a tree that never existed.

### 7.3 Simulator contract

```ts
export interface ReplaySimulator {
  reset(caseId: string): void;
  step(action: ReplayAction): ReplayTransition;
  counterfactual(stateHash: string, actions: readonly ReplayAction[]): readonly ReplayTransition[];
}

export type ReplayTransition =
  | { kind: 'HIT'; node: DiscoveryNode; nextStateHash: string }
  | { kind: 'BOUNDARY_MISS'; stateHash: string; alternatives: readonly ReplayAction[]; reason: string };
```

`ReplaySimulator.counterfactual(state, actions)` resolves several actions against one state from history, so comparing alternatives costs a lookup rather than a model call. `recordedActions(state)` lists what the tree actually tried from that state, parameters included: two `move_relative` calls at different distances are different alternatives, and guessing the action set would make the answer depend on the guess. An action never taken from that state resolves to a boundary miss, which is itself the answer.

The replay report carries `counterfactuals`, one entry per visited node that has recorded alternatives, satisfying the functional requirement that replay results include hit, miss, visited nodes, counterfactual branches, simulation cost, and critical path.

Replay may read snapshot and artifact store only. The implementation must not import the Harness LLM client, execute tools, start a sandbox, access network, or mutate the source store. A replay purity test should run with those capabilities denied.

## 8. Evaluation Design

### 8.1 Metrics

For visited nodes:

```text
Q_raw = max(score(node)) or 0
C_raw = sum(tokenCost(node) + gamma * execTimeMs(node))
P_raw = totalExecTime / max(criticalPathMs, 1)
M = boundaryMissCount / max(totalAttempts, 1)

Q = Q_raw / max(qualityReference, 1)
C = C_raw / max(costBudget, 1)
P = P_raw / max(idealParallelEfficiency, 1)
S = wq*Q - wc*C + wp*P - boundaryPenalty*M
```

Store Q, C, P, M and S separately. A single score cannot hide a quality or safety regression.

### 8.2 Evaluation request and report

```ts
export interface EvaluationRequest {
  snapshotId: string;
  policyArtifactId: string;
  split: 'train' | 'validation' | 'holdout';
  seed: string;
  configHash: string;
}

export interface EvaluationReport {
  evaluationId: string;
  evaluatorVersion: string;
  sourceHash: string;
  snapshotId: string;
  policyArtifactId: string;
  split: EvaluationRequest['split'];
  configHash: string;
  metrics: { quality: number; cost: number; parallelEfficiency: number; missRate: number; score: number };
  caseResults: readonly CaseResult[];
  sampleCount: number;
  passed: boolean;
  guardResults: readonly GuardResult[];
  createdAt: string;
  signature?: string;
}
```

`configHash` is `hashDreamRsiConfig(config)`: a score is only comparable with another taken under the same configuration. `signature` is not implemented; signing is tracked as an open blocker.

Reports are generated outside candidate code. The current repository has a child-process evaluator with timeout; before untrusted candidate code is accepted, add OS/container controls for memory, CPU, filesystem, network and output size.

### 8.3 Isolation protocol

Parent process sends one JSON request to a worker over stdin. Worker returns one JSON response over stdout and exits. Parent enforces timeout, captures abnormal exit, and never trusts worker output without schema validation. The production worker must additionally:

- use read-only snapshot/holdout mounts;
- deny secrets and network by default;
- limit CPU, memory, process count, output bytes and wall time;
- kill the complete process group on timeout;
- write only a temporary result that parent validates and atomically promotes.

#### Node permission model

`src/operations/isolated-child.ts` spawns every isolated child under Node's permission model by default: `--experimental-permission` with a read grant scoped to the child's own directory, and no write or `child_process` grant. A confined child that attempts either receives `ERR_ACCESS_DENIED`, which bounds filesystem writes and process count before the process-group kill is even relevant.

Two details are load-bearing. The entry point and every granted path are resolved with `realpathSync` first, because `tmpdir()` is a symlink on macOS and a grant written as `/var/...` never matches the `/private/var/...` path the child computes when it resolves itself. And an explicit grant is resolved the same way as the derived one, or the caller's grant silently fails.

This is defense in depth, not the OS/container sandbox. Node documents the permission model as not a security boundary against hostile native code, and it does not restrict network access. `confinement: false` exists for a host that cannot use the flag, and says so rather than silently degrading.

## 9. Evolution and Candidate Design

### 9.1 Policy artifact

```ts
export interface PolicyArtifact {
  /** SHA-256 over the artifact body, excluding `createdAt`. */
  artifactId: string;
  version: string;
  parentVersion: string | null;
  sourceSha256: string;
  manifest: { entrypoint: string; dependencies: readonly string[]; schemaVersion: number };
  allowedCapabilities: readonly string[];
  createdBy: 'human' | 'evolution-agent';
  createdAt: string;
}
```

Candidates are immutable artifacts. The Evolution Agent may output source, diff, manifest and build identifier, but cannot write `current` directly.

`artifactId` is the hash of the artifact body, so two identical artifacts share an id and a record whose body does not match its id is rejected on registration and on load. `sourceRef` points at the stored source and is verified separately from the id, because a reference is a location and must not change what the artifact is.

### 9.1.1 Policy registry

`src/registry/policy-registry.ts`. Policies, evaluation reports, and deployments are append-only and identified by content hash. The current-policy pointer is the only mutable state.

`promotePolicy(artifactId, { evaluationId, approval, canary })` runs every check before any mutation, so a rejected promotion leaves the registry byte-identical:

1. the artifact is registered;
2. `approval.decision` is `approved`, with an operator identity;
3. `canary.passed`;
4. the evaluation exists, covers this artifact, and passed.

Persistence goes through a `PolicyRegistryStore` port. `FilePolicyRegistryStore` writes one file atomically and re-verifies every record on load, so a tampered or truncated registry is refused at construction rather than silently trusted. Approval is always explicit, so nothing in this path deploys automatically.

### 9.2 Candidate generation

Evolution Agent input: policy source, type contracts, selected train/validation results and replay snapshot metadata. It does not receive holdout records, deployment secrets or evaluator internals.

Allowed mutation classes:

- frontier/priority queue ordering;
- branch scheduling and bounded parallelism;
- early stopping and pruning thresholds;
- resource budget allocation;
- retry and exploration coefficients.

Natural-language summaries may be retained for diagnostics but cannot become automatic hard pruning rules without explicit policy review.

#### Implemented generation (`src/evolution/candidate-generator.ts`)

`generateCandidate(llm, input)` takes a `HarnessLlm` and nothing wider — no provider SDK, no credentials, no registry — so the generation path has no route to the current-policy pointer.

**Input projection.** The prompt is built from named fields, never by serializing the input. A caller that attaches holdout results, evaluator internals, secrets, or deployment state cannot leak them into the prompt by doing so, and a test asserts marker strings appear nowhere in the request.

**Mutation boundary.** A proposal naming a class outside `MUTATION_CLASSES` is rejected during parsing, before its source reaches any other guard. The artifact's `allowedCapabilities` are then derived from the approved classes, so a candidate cannot declare its own capabilities.

**Strict parsing.** A missing or mistyped field is rejected rather than defaulted, and the manifest is built by the host: a model reply supplies source, rationale, mutation classes, and at most a dependency list.

**Reproducible identity.** `buildIdentifier` is a pure function of parent version, source hash, manifest, and seed, so identical generations share an id.

**Evaluate-only.** `evaluateCandidate` generates, scans, registers the artifact, and evaluates. It returns `promoted: false`, and the pointer is asserted unchanged. A candidate that trips the guard registers nothing and is never evaluated: the gate runs before registration, so a rejected candidate costs no episode.

### 9.2.1 Tool synthesis

`src/tools/`. A synthesized tool is a named macro over already-validated action primitives.

**Mining** (`subgraph.ts`). A pattern is the same ordered sequence of actions that succeeded in more than one run. Only completed steps count, and a failure splits the run: a sequence spanning a failure is never treated as contiguous. The signature is canonical, so parameter key order does not matter. Occurrences and the distinct tasks they came from are recorded as the pattern's evidence.

**Artifact** (`synthesized-tool.ts`). Every field a reviewer needs is part of the artifact and part of its id: name, version, description, input and output JSON Schema, source, tests, dependencies, permissions, origin, and the pattern signature. `createSynthesizedTool` is the single constructor, so a model-authored tool enters through the same id and verification rules as a template-generated one.

**Permissions.** `ToolPermission` is `` `action:${EmbodiedActionType}` ``. Joint velocity, raw motor commands, and unwrapped hardware channels have no representation, so a tool cannot request them. A subpath does not evade a capability check: `fs/promises` inherits `fs`.

**Gates** (`tool-gate.ts`). Static: AST, dependency allowlist, resource/network capability. The tool's *test source* is scanned by the same rules. Dynamic: the tests run in a child process that leads its own group, with a deadline, bounded output, and a `PATH`-only environment. A tool whose tests cannot run has not passed them.

This is process isolation, not a sandbox. Filesystem and network confinement remains the open blocker.

**Registry** (`tool-registry.ts`). A tool enters as `candidate` and is selectable only while `enabled`. Enabling requires an operator and a clean gate: a tool with any failed guard cannot be enabled later by presenting a different verdict, because the verdict is stored with the candidate. Disabled tools are absent from `selectable()` and resolve to nothing, not to a deprioritised entry. Rollback restores the version that was live before, so the registry never shows two enabled versions of one name.

### 9.3 Guard pipeline

```text
candidate source
  -> parse/type check
  -> AST forbidden-node/import check
  -> dependency allowlist
  -> resource/network capability check
  -> isolated build/test
  -> train replay
  -> validation replay
  -> holdout replay
  -> monotonic gate
  -> human approval or explicit auto-deploy policy
  -> canary
  -> deployment
```

Any failure rejects the candidate and leaves current policy unchanged.

## 10. Monotonic Gate

Candidate and current policy must evaluate the identical case ID set. Required checks:

- configured minimum pass ratio, default 95%, where candidate score is not below current score;
- candidate score >= current score + `minimumImprovement`;
- boundary miss rate <= configured maximum;
- quality, cost and parallel budgets pass independently;
- holdout minimum sample count and confidence requirement pass;
- no AST, dependency, resource or signature failure.

The gate result is immutable and records every rejection reason, case-level difference and configuration hash.

#### Implemented (`src/evolution/holdout-gate.ts`)

`evaluateHoldoutGate` consumes two `EvaluationReport`s rather than bare case lists, and checks each requirement separately:

| Check | Rejection |
|---|---|
| Both sides on the holdout split | comparing a holdout candidate against a train incumbent would report a gain no unseen task supports |
| Both sides share `configHash` | scores taken under different configurations are not comparable |
| Pass ratio and score improvement | delegated to `evaluateMonotonicGate`, which also requires identical case-id sets |
| `minimumHoldoutSamples` | overfitting on a small sample |
| `maxMissRate`, `minQuality`, `maxCost`, `minParallelEfficiency` | each checked alone, so a cost win cannot offset a quality regression |
| Candidate `guardResults` | a failed AST, dependency, resource, or signature guard |
| Per-task-family pass ratio | one family regressing while the aggregate holds |

The thresholds come from configuration through `runtime.evaluationSettings.holdoutGate`: `evolution.minimumPassRatio`, `evolution.minimumImprovement`, `evaluation.minimumHoldoutSamples`, and `replay.missRateMax`. They previously came from the gate's own defaults regardless of configuration, so the non-regression ratio the paper calls configurable was not.

The result is deep-frozen and carries the configuration hash, both evaluation ids, the failed case ids, and a per-family verdict with that family's rejection reasons.

`CaseResult` carries per-case `quality` and `score`. The gate needs them to compare two runs case by case, so a report without them is rejected rather than treated as equal.

**Promotion requires the verdict.** `PolicyRegistry.promotePolicy` demands a passing `holdoutGate` whose `candidateEvaluationId` equals the evaluation being deployed, so a verdict taken over some other evaluation cannot justify a promotion.

Not implemented: the confidence requirement, and signature failure (signing is an open blocker).

## 11. Deployment, Canary and Rollback

### 11.1 Deployment state

```text
PROPOSED -> APPROVED -> CANARY -> ACTIVE
PROPOSED -> REJECTED
APPROVED -> ROLLED_BACK
CANARY -> ROLLED_BACK
ACTIVE -> DEGRADED -> ROLLED_BACK
```

Only the deployment writer can transition state. The state record includes policy artifact, evaluation report, operator/approval, lock owner, timestamps and rollback target.

### 11.2 Atomic deployment

1. Acquire deployment `SingleWriterLock` lease.
2. Verify artifact checksum, signature and parent version.
3. Confirm current version still matches the gate baseline.
4. Write deployment intent/audit record.
5. Start canary using immutable artifact.
6. Check quality, error rate, latency and cost thresholds.
7. Atomically update current pointer.
8. Emit `dream-rsi/policy-deployed`.
9. Release lock and retain previous stable versions.

A failure before step 7 leaves current pointer untouched. A failure after step 7 triggers health monitoring and rollback to the previous verified stable artifact.

### 11.3 Writer lease

`SingleWriterLock` uses atomic directory creation, lease metadata, expiry recovery and heartbeat. A crashed owner is recoverable after lease expiry. Recovery must be audited, and production should additionally use a monotonic clock/transactional storage where available to avoid wall-clock anomalies. `SingleWriterLock.recoveredStaleLock` reports a takeover so the caller can emit a `lock.recovered` event.

#### Implemented (`src/registry/deployment-writer.ts`)

`DeploymentWriter` is the only component that moves a deployment between states, and every transition holds the deployment writer lease, so two writers cannot interleave a state machine.

| Transition | Gate |
|---|---|
| `propose` | the artifact is registered, the evaluation covers it and passed, and the holdout gate passed and covers that evaluation. Records `rollbackTarget` as the policy live at proposal time |
| `decide` | `PROPOSED -> APPROVED` or `PROPOSED -> REJECTED`, with an operator identity |
| `startCanary` | `APPROVED -> CANARY`, after verifying the artifact checksum and signature |
| `completeCanary` | `CANARY -> ACTIVE` or `CANARY -> ROLLED_BACK` from the threshold verdict |
| `markDegraded` | `ACTIVE -> DEGRADED` |
| `rollback` | to `ROLLED_BACK`, degrading an active deployment first, then restoring the pointer |

Deployment records carry `history`, so the path taken is recoverable even though `state` is mutable. The `holdoutGate` verdict is recorded at proposal time and passed through at activation unchanged: activation must re-check the evidence that was actually reviewed, not a freshly synthesized one.

**Baseline check.** Activation is refused when the current policy no longer matches the `rollbackTarget` recorded at proposal, because gate evidence taken against a policy that is no longer live proves nothing.

**Signature posture.** `SignatureVerifier` is a seam, and its absence is a refusal rather than a bypass: an unsigned artifact must not reach production because nobody wired the check. The signing scheme itself is an open blocker.

**Audit.** `AuditSink` is append-only; `FileAuditLog` writes one JSON object per line and never rewrites. Each event's `eventId` is the hash of its body, so a reader can tell whether a line was altered. Degradation performed as part of a rollback is emitted as its own `policy.degraded` event.

## 12. Security Model

Threat actors include a generated candidate, malicious tool output, prompt injection, compromised backend and accidental operator misuse.

Controls:

- Frozen model and explicit Harness adapter.
- Candidate source checksum, dependency allowlist and AST guard.
- Process/container isolation with no secrets and restricted network/filesystem.
- Read-only snapshot and holdout mounts.
- Capability profile and high-level embodied actions only.
- Per-session authorization, confirmation, mutex, lease, rate limit and emergency stop.
- Input/output size limits and redacted logs.
- Immutable audit trail for approval, deployment and rollback.
- Retention and deletion policy for observation artifacts.

AST checking is a prefilter, never the security boundary. Any candidate capable of executing code must run in an OS-level restricted environment.

#### Implemented governance

**Secret redaction** (`src/governance/redaction.ts`). Rules cover provider keys, bearer tokens, JWTs, `Authorization` headers, credential-shaped assignments, and credentials embedded in URLs. Rules are reusable across calls: they carry the `g` flag, so `lastIndex` is reset or alternating calls would skip matches.

Redaction applies where data is *emitted for operators* — audit reasons, before they are stored and hashed — and never to recorded ground truth. A discovery node must record what the environment actually returned, or replay stops reproducing it.

**Access control** (`src/governance/access-control.ts`). Deny by default: a principal with no matching role is refused, and an action absent from the policy is refused rather than assumed permitted. `approve` and `deploy` are separate grants from `evolve`, so the principal that proposes a candidate is not automatically the one that may put it live. `admin` is the break-glass role.

Every governed transition on the deployment writer checks the acting principal before reading or writing state, so a denial changes nothing. The writer also refuses an approval recorded under another principal's name: recording someone else's approval is not approval.

**Retention** (`src/governance/retention.ts`). Decided per artifact kind at write time; a caller cannot shorten it, so a tool cannot arrange for its own evidence to expire. Policy, tool, and evaluation artifacts are retained indefinitely because they are the audit trail. `pruneExpired` and `expiredArtifacts` never remove anything on their own.

**Production policy** (`PRODUCTION_POLICY.md`). States the safety defaults as a machine-readable block that a test compares against `resolveDreamRsiConfig({})`, so the document cannot drift from the code in either direction. While any release blocker remains open, `evolution.autoDeploy` stays `false`.

#### Candidate gate

Two independent checks run over the same source before a candidate is evaluated or executed, composed by `scanCandidate` and enforced by `assertCandidateAccepted`:

| Guard | Rejects |
|---|---|
| `runAstGuard` | `eval`, `Function`, `exec*`/`spawn*`, dynamic `import()`, non-literal `require()`, forbidden module specifiers, `process.env`/`binding`/`kill`/`mainModule` |
| `checkImports` | a relative import resolving outside the candidate root; a package absent from the allowlist; a built-in absent from the allowlist; any built-in that grants a capability |

Built-ins are classified by the capability they grant — filesystem, network, process, secrets, code-generation, concurrency. **A capability-granting built-in cannot be allowlisted at all**, because approving it by name would make the profile meaningless. The unlisted remainder falls to the package allowlist and is denied, so a new Node release cannot silently widen what a candidate may reach.

Both guards are pure functions of the source string: no state, no mutation, and the same input always yields the same verdict.

#### Evaluator isolation

The evaluator runs in a child process that leads its own process group (`detached: true`). A deadline, a cancellation, or an output overflow kills the whole group, because killing only the direct child leaves grandchildren running with the host's privileges.

| Control | Behaviour |
|---|---|
| Deadline | `timeoutMs`, default 5000 |
| Cancellation | `signal`; kills the group |
| Output bound | `maxOutputBytes` on stdout and on stderr, default 1 MiB |
| Environment | `PATH` only. Inheriting `process.env` would hand the child every API key the parent holds |
| Result validation | Fields are rebuilt from untrusted JSON rather than cast, so a crafted response cannot inject extra properties |

An observation whose `schemaVersion` is not the expected one fails the episode before a Discovery node is built. Recording it would put the mismatch into the replay key, producing a silently different key instead of an error — the one thing a version field exists to prevent.

Every child is spawned under Node's permission model (`--experimental-permission`) with a read grant scoped to its own directory and no write or `child_process` grant, which bounds filesystem writes and process count. CPU, memory, and network limits still require OS-level confinement and are not implemented; Node documents the permission model as not a security boundary against hostile native code.

## 13. Observability and Audit

Every event and metric carries:

- `taskId`
- `episodeId` when applicable
- `policyVersion`
- `evaluationId` when applicable
- `correlationId`
- timestamp and schema version

#### Implemented

**Metrics** (`src/observability/metrics.ts`). `InMemoryMetrics` records `(name, value, labels)` samples. Labels are compared canonically, so key order never splits a group, and undefined labels are dropped rather than forming a phantom group. A non-finite value is refused, because one NaN silently poisons every aggregate that contains it. `summary()` returns count, total, min, max, and mean per metric and label set.

The episode pipeline records `task.outcome` with the terminal status as a label, `episode.stepCount`, `episode.durationMs`, the five evaluation metrics, and replay hits and misses.

**Audit** (`src/registry/audit.ts`). One append-only trail, generalised from deployments to a `subject`: `deployment`, `session`, or `tool`, with `subjectId` naming the deployment, session, or tool. An operator stop is recorded as `action.emergency-stop` whether or not an action was in flight, because the stop is the fact, not the interruption.

**Report** (`src/observability/report.ts`). `buildObservabilityReport` produces a JSON-serializable snapshot: Q/C/P/M/S per evaluation with a per-family breakdown, case and pass counts, deployment history including the path taken, the current policy pointer, and metric summaries. An aggregate score hides which family regressed, which is the part that can be acted on.

Each family carries quality, cost, latency, and miss rate as aggregates with sample counts and a 95% confidence interval (`src/observability/statistics.ts`). Small samples use a Student-t critical value rather than 1.96: at four samples the interval is roughly 1.4x wider, which is the difference between "no regression" and "cannot tell yet". A single sample reports `lower` and `upper` as `null` rather than a zero-width interval, because one observation cannot support a precision claim. A non-finite sample is refused.

**Action vocabulary.** `checkCapability` denies any action absent from `EMBODIED_ACTION_TYPES`, so a forged capability profile cannot widen the allowlist. Raw motor and joint control have no representation in the type, and the check closes the same gap at runtime.

**Replay purity** (`test/provenance.test.mjs`). The replay modules are asserted to import no model client, tool, sandbox, or network capability, and a replay is asserted to leave the source store byte-identical and the snapshot frozen. Replay reads a snapshot and nothing else.

**Failure injection** (`test/failure-injection.test.mjs`). Provider outage, worker crash, stale lease, corrupted artifact, timeout, cancellation, and rollback failure. Each case asserts which state must be left untouched — the registry, the pointer, the store, or the transition log — rather than only that an error surfaced.

Required metrics:

- task success, quality, retry, timeout and cancellation rates;
- DeepSeek token/cost/latency and tool/backend latency;
- replay hit ratio and boundary miss rate;
- Q/C/P/M/S per policy and task family;
- candidate rejection reasons, approval latency, canary results and rollback count;
- action failure, emergency-stop and capability-denial rates;
- lock acquisition, expiry recovery and job duration.

Logs must redact API keys, secrets, full prompts where not needed, and unnecessary personal data.

## 14. Repository and Module Layout

Target layout, retaining current modules where possible:

```text
src/
  index.ts
  config.ts
  adapter/
    cordis.ts
    harness.ts
    environment.ts
  embodied/
    backend.ts
    capability-profile.ts
    action-state-machine.ts
    perceive.ts
    act.ts
    query-state.ts
    events.ts
  discovery/
    models.ts
    sqlite-store.ts
    artifact-store.ts
  replay/
    key.ts
    snapshot.ts
    simulator.ts
  evolution/
    evaluator.ts
    evaluator-worker.ts
    isolated-evaluator.ts
    split.ts
    monotonic-gate.ts
    candidate-generator.ts
  guardrails/
    ast-guard.ts
    resource-guard.ts
  deployment/
    policy-registry.ts
    canary.ts
    rollback.ts
  operations/
    single-writer-lock.ts
    job-runner.ts
```

Core dependencies flow inward:

```text
Cordis/DSH adapter -> runtime/embodied/deployment adapters
                     -> core interfaces
                     -> storage/replay/evaluator primitives
```

Core modules must not import simulator SDKs, Cordis context, or network clients.

## 15. API and Error Conventions

Errors are structured and safe to expose:

```ts
export interface DshRsiError {
  code:
    | 'CONFIG_INVALID'
    | 'CAPABILITY_DENIED'
    | 'ACTION_TIMEOUT'
    | 'ACTION_CANCELLED'
    | 'EMERGENCY_STOP'
    | 'REPLAY_BOUNDARY_MISS'
    | 'EVALUATION_TIMEOUT'
    | 'EVALUATION_INVALID'
    | 'GUARD_REJECTED'
    | 'GATE_REJECTED'
    | 'LOCK_UNAVAILABLE'
    | 'ARTIFACT_INTEGRITY_FAILURE';
  message: string;
  retryable: boolean;
  correlationId: string;
  details?: JsonObject;
}
```

Never include secrets, arbitrary source dumps or unbounded backend output in an error response.

## 16. Testing Strategy

### Unit tests

- canonical JSON and ReplayKey normalization;
- repository idempotency and indexes;
- split determinism and no task leakage;
- evaluator numerical formulas and invalid input handling;
- snapshot immutability and hash stability;
- lock ownership, heartbeat, expiry recovery and release;
- action state machine terminal transitions;
- capability profile allow/deny.

### Integration tests

- Cordis apply/dispose and partial setup failure;
- three embodied tools with per-session isolation;
- online task to Discovery DAG;
- snapshot to replay to evaluation;
- evaluator worker timeout and abnormal exit;
- candidate guard to gate to report;
- deployment canary and rollback.

### Security and failure tests

- forbidden AST/import/network/filesystem access;
- holdout read/write attempts;
- prompt injection in observation/tool output;
- worker crash, process-group kill and stale lease;
- corrupted artifact/checksum mismatch;
- provider outage and exhausted retry budget;
- emergency stop followed by retry attempt.

Acceptance target: deterministic tests must differ by less than `1e-6` for repeated identical inputs; security failures must leave current policy and deployment registry unchanged.

## 17. Open Decisions

1. Exact DSH profile manifest and `cordis.patch.yml` schema for the deployment target.
2. DeepSeek Harness LLM facade and session identity contract.
3. First simulator/task family and observation coordinate system.
4. Signature provider and key rotation policy.
5. Production sandbox technology: container, worker VM or platform sandbox.
6. Artifact retention, encryption and personal-data deletion requirements.
7. Whether production auto-deploy is ever allowed without human approval.

Until these decisions are resolved, defaults remain: simulator backend, evaluate-only, auto-deploy disabled, high-risk confirmation required, no secrets in evaluator, and process/container isolation required for generated code.
