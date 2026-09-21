# Dream-RSI Harness TODO

**更新日期**：2026-09-22  
**目前 baseline**：359 tests passing。`main` 僅存在於本機，尚未推送至 GitHub。  
**原則**：先完成可驗證的安全邊界，再開啟 candidate generation 或自動部署。

## Status Legend

- `[x]` 已完成並有測試或文件證據
- `[ ]` 尚未完成
- `[!]` release blocker 或需要外部決策

## Completed Baseline

- [x] 固定 Node.js >=22.5、TypeScript、Cordis 與 DSH tools 版本
- [x] Cordis `apply(ctx, config?)` plugin entrypoint，`inject` 宣告所用 service（`tools`；未宣告會讓 activation 與 provider 競態，讀不到時 Cordis 丟 `cannot get property "tools" without inject`）
- [x] `ctx.effect()` reversible tool registration/disposal
- [x] Mock embodied backend 與 per-session state isolation
- [x] `embodied_perceive`、`embodied_act`、`embodied_query_state`（perceive 輸出帶 `frame_id` 與 `schema_version`，接受 `sensor_types`／`include_pose`，未宣告的 sensor 直接拒絕）
- [x] `embodied_act` 逾時與取消對非同步 backend 真正生效（backend 可注入延遲並回應 `AbortSignal`，逾時/取消都不會讓 state 被 mutate）
- [x] Typed embodied action events
- [x] In-memory 與 SQLite Discovery Store
- [x] Discovery idempotency key 與 duplicate retry protection
- [x] Canonical ReplayKey 與 deterministic Replay Simulator
- [x] Boundary miss 與 counterfactual replay behavior（`ReplaySimulator.counterfactual` 與 `recordedActions`，replay report 帶 `counterfactuals`）
- [x] Q/C/P/M evaluator
- [x] Task-level train/validation/holdout split
- [x] Strict Monotonic Gate 與 candidate case-set validation
- [x] Immutable evaluation snapshot 與 content hash
- [x] Process-isolated evaluator with timeout
- [x] Single-writer lock、lease、heartbeat、stale-lock recovery
- [x] Validated configuration與安全預設
- [x] `src/adapter/cordis.ts` 邊界：`index.ts` 不再直接持有 Cordis 註冊邏輯
- [x] `dream_status` 唯讀工具（config 的安全相關投影，無副作用）
- [x] 最小可用 AST guard（`src/guardrails/ast-guard.ts`，以 TypeScript compiler AST 為基礎，非完整沙盒）
- [x] Functional spec、project plan、detailed design spec、technical paper

## P0: Next Implementation Milestone

### 1. Cordis Profile/Patch Adapter

- [x] Confirm target DSH profile manifest and `cordis.patch.yml` schema against the deployed Harness version. Verified against DSH 0.1.5-rc.1 / `cordis-plugin-loader` 1.0.3; see BASELINE.md.
- [x] Add `src/adapter/cordis.ts` so core modules do not depend directly on Cordis APIs.
- [x] Add profile and patch examples for local development (`cordis.patch.yml`, `examples/README.md`).
- [x] Add compatibility tests for mount, duplicate mount, partial setup failure, dispose, and reload (`test/adapter-compat.test.mjs`).
- [x] Verify that tool, event, service, command, and worker registrations leave no residue after disposal, and that the mounting contract holds: the manifest points at a patch that exists, the patch parses and inserts one row whose id and name agree with the plugin and the package, the example override addresses that same row id, and the package publishes and exports the patch.
- [x] Ship the bundle patch (`cordis.patch.yml` plus `dsh.bundle.patch`), without which a profile cannot mount the package at all.

### 2. Configuration and Runtime Wiring

- [x] Add typed configuration defaults and validation, including `embodied.allowActions`: configuration narrows the declared action set and can never widen it, an action outside the vocabulary is refused at load, and an empty allowlist is refused rather than leaving a backend that cannot act.
- [x] Add configuration schema export for the host Harness (`Config`, Schemastery; the Cordis loader validates each fiber's `config` against it before `apply` runs).
- [x] Connect validated config to Discovery store, embodied backend, split config, and writer lock construction (`src/runtime.ts`).
- [x] Derive replay and evaluator settings (`replay.maxNodes`, `replay.missRateMax`, `evaluation.timeoutMs`, `evaluation.minimumHoldoutSamples`) in the runtime, applied by `src/tasks/pipeline.ts`. The holdout gate's thresholds are derived too (`evaluationSettings.holdoutGate`), including `evolution.minimumPassRatio` and `evolution.minimumImprovement`; before that the gate only ever used its own defaults, so `minimumImprovement` was configurable in name only.
- [x] Add `dream status` read-only runtime facade (exposed as the `dream_status` tool, since no verified Cordis/DSH command contract exists yet; see `src/status.ts`). It carries the readiness report when it is given a runtime, and omits the field rather than inventing one when it is not.
- [x] Reject invalid configuration before any persistent resource or tool registration is created (the schema runs in `apply` before `ctx.effect`; `createDreamRsiRuntime` validates before opening SQLite).

### 3. End-to-End Mock Task

- [x] Define `Task`, `Episode`, and `ResourceBudget` schemas (`src/tasks/models.ts`) and `Observation`, `ActionRequest`, `ActionResult`, and `EnvironmentAdapter` (`src/embodied/protocol.ts`).
- [x] Execute one complete mock task through perceive -> policy/tool action -> result -> Discovery node (`src/tasks/runner.ts`); one node per step, including failed, timed-out, and cancelled attempts.
- [x] Link task, episode, session, policy version, correlation ID, and action ID in every trace (`episodeId` added to `DiscoveryNode` and persisted in the SQLite store).
- [x] Run the same episode through snapshot -> Replay -> evaluator (`src/tasks/pipeline.ts`). Documented as a determinism check, not generalization evidence.
- [x] Add success, failure, timeout, cancellation, and emergency-stop fixtures, plus budget, environment-binding, idempotency, and boundary-miss cases (`test/end-to-end.test.mjs`, 77 tests total).

## P1: Safety and Evaluation Readiness

### 4. Action Safety Contract

- [x] Implement capability profiles for sensors, actions, coordinate frames, limits, and risk levels. The declaration lives in the environment layer (`src/embodied/capability.ts`) and enforcement in the safety layer (`src/safety/capability.ts`), because a backend declares its profile and safety checks it; `EnvironmentAdapter.capability()` exposes it. An undeclared action, frame, parameter, limit, or **sensor** is denied, never defaulted.
- [x] Implement action state machine `REQUESTED -> AUTHORIZED -> EXECUTING -> terminal` (`src/safety/action-state.ts`); the spec diagram is the transition table and terminal states absorb.
- [x] Add action lease, session mutex, idempotency, rate limit, timeout, cancellation, and emergency stop (`src/safety/action-guard.ts`), dispatched by the episode runner through `RunEpisodeOptions.guard`.
- [x] Prohibit automatic retry after emergency stop: the latch is checked before the idempotency lookup, so a previously recorded result cannot be replayed as a retry.
- [x] Add authorization and high-risk confirmation tests (`test/action-safety.test.mjs`, 17 tests). Confirmation is denied by default when no host approval hook is configured.
- [x] Dispatch `embodied_act` through the action guard so the tool path obeys the same capability, confirmation, and state-machine contract as the episode path. The tool observes first, so an action is authorised in the frame of the state it was decided from.

### 5. Artifact and Snapshot Integrity

- [x] Align `DiscoveryNode` with the detailed design schema (`schemaVersion`, `createdAt`, optional `sessionId`/`episodeStep`/`correlationId`/`criticalPathMs`) and persist all fields in the SQLite store.
- [x] Implement content-addressed artifact store with SHA-256, kind, schema version, byte length, retention, and deletion metadata (`src/artifacts/store.ts`); blobs are immutable and metadata is the only mutable state.
- [x] Materialize ReplaySnapshot from a consistent SQLite read transaction: `DiscoveryStore.readAll()` serves the tree under one deferred transaction, and `EpisodePipelineOptions.snapshotSource: 'store'` snapshots the persisted tree rather than the run in memory.
- [x] Revised: snapshot identity covers content only (`schemaVersion` + `splits`), with `createdAt` recorded but excluded. Including creation time meant two snapshots of the identical tree never shared an id, so the id was not the content address the design claims. Node-level `createdAt` values remain part of the content.
- [x] Add artifact checksum verification before evaluation (`assertArtifactsVerified` runs before the evaluator and fails the run). Deployment does not exist yet; it must call the same function rather than re-implement the check.
- [ ] Select and implement a signing scheme: provider, verification, key rotation, and failure tests. `[!]` Covers both the artifact signature in item 5 and the deployment-time signature check in item 10.

### 6. Strong Evaluator Isolation

- [x] Process boundary and timeout wrapper.
- [x] Add cancellation and process-group termination. The child leads its own process group (`detached: true`), so a deadline or abort kills everything it spawned; killing only the direct child leaves grandchildren running with host privileges.
- [x] Add output schema validation and bounded stdout/stderr. Captured output is capped at `maxOutputBytes`, and the result is rebuilt field by field from untrusted JSON rather than cast, so a crafted response cannot smuggle extra properties.
- [ ] Add CPU, memory, process-count, wall-time, filesystem, and network limits. Wall-time, output bound, and process-count termination are in place, and Node's permission model now denies filesystem writes and child processes (see `src/operations/isolated-child.ts`). CPU, memory, and network limits still need OS-level confinement.
- [ ] Select and implement container or OS-level sandbox before running untrusted candidate code. `[!]`
- [x] Keep host secrets and evaluator internals out of a candidate's reach: the child is spawned with `PATH` only, so inheriting `process.env` cannot hand it the host's API keys.
- [x] Ensure holdout data is inaccessible to candidates: `GenerateCandidateInput` carries train and validation metrics only, and the prompt projection is asserted free of holdout markers. The holdout mechanism itself arrives with the benchmark (item 13).

### 7. Guardrails

- [x] Implement AST guard for forbidden calls and dynamic imports (`src/guardrails/ast-guard.ts`, rule-based on the TypeScript compiler AST; not a full sandbox).
- [x] Implement dependency/import allowlist (`src/guardrails/import-allowlist.ts`): relative imports must resolve inside the candidate root, packages are matched against an explicit list, and an unlisted built-in is denied rather than assumed harmless.
- [x] Implement resource and network capability guard: built-ins are classified by the capability they grant (filesystem, network, process, secrets, code-generation, concurrency), and a capability-granting built-in cannot be allowlisted at all.
- [x] Add prompt-injection and malicious tool-output fixtures (`test/fixtures/malicious-candidates.mjs`), each naming the rule that must catch it; `scanCandidate` composes both guards and is wired into the pipeline before the episode runs.
- [x] Verify every guard rejection leaves current policy and deployment registry unchanged: a rejected candidate, a rejected promotion, and a tampered registry file each leave the pointer and every record untouched (`test/registry.test.mjs`).

## P1: Evolution and Deployment

### 8. Immutable Policy and Evaluation Artifacts

- [x] Define `PolicyArtifact`, `EvaluationReport`, `Deployment`, `Approval`, and `CanaryResult` models (`src/registry/models.ts`); every record's identity is the hash of its own content, so a body that does not match its id is rejected.
- [x] Add source hash, parent version, evaluator version, snapshot ID, config hash, and dependency manifest. `hashDreamRsiConfig` records the configuration a score was taken under, so two scores are only comparable when it matches.
- [x] Add immutable artifact registry and current-policy pointer (`src/registry/policy-registry.ts`). Records are append-only; the pointer is the only mutable state and moves only through `promotePolicy`, which requires a registered artifact, a passing evaluation covering it, an explicit operator approval, and a passing canary. Every check runs before any mutation.
- [x] Add report persistence (`FilePolicyRegistryStore`, re-verifying every record on load so a tampered file is refused) and rejection reasons by case/task family (`summarizeCaseResults`).
- [x] Persist candidate source as an artifact and record its reference on the policy artifact (`sourceRef`, `createPolicyArtifactWithSource`). The reference is not part of the artifact id, because a location must not change what the artifact is; `verifyPolicyArtifactSource` checks that the referenced bytes hash to `sourceSha256`.
- [x] Extend the gate to holdout evaluation reports (`src/evolution/holdout-gate.ts`): both sides must be holdout and share a `configHash`, and quality, cost, parallel efficiency, miss rate, sample sufficiency, and candidate guard failures are each checked independently so a cost win cannot offset a quality regression.
- [x] Report per-task-family verdicts and reject when any single family falls below the pass ratio, with that family's rejection reasons summarised.
- [x] Require a passing holdout gate verdict for promotion, structurally checked against the evaluation being deployed so a verdict over some other evaluation cannot justify it.
- [x] Carry per-case `quality` and `score` on `CaseResult`; a report without them is rejected by the gate rather than treated as equal.

### 9. Candidate Generation

- [x] Build Evolution Agent adapter using only the Harness LLM facade (`src/evolution/harness.ts`). `generateCandidate` receives `HarnessLlm` and nothing wider, so it has no provider SDK, credentials, or registry to reach.
- [x] Restrict candidate mutations to scheduling, pruning, retry, parallelism, and budget logic. A proposal naming any other class is rejected during parsing, and the resulting artifact's `allowedCapabilities` are derived from the approved classes rather than declared by the candidate.
- [x] Keep holdout data, evaluator internals, secrets, and deployment state outside candidate input: the prompt is projected from named fields rather than serialized, so a caller that attaches them cannot leak them, and both the prompt and the whole request are asserted free of marker strings.
- [x] Add evaluate-only candidate generation. `evaluateCandidate` generates, scans, registers, and evaluates, and returns `promoted: false`; it has no path to the current-policy pointer, and a mutation test confirms the pointer is untouched.
- [x] Add deterministic seed and reproducible build identifier (`buildIdentifier`): a pure function of parent version, source hash, manifest, and seed, so identical generations share an id.

### 10. Deployment, Canary, and Rollback

- [x] Implement deployment state machine: `PROPOSED -> APPROVED -> CANARY -> ACTIVE` (`src/registry/deployment-state.ts`, `src/registry/deployment-writer.ts`). `ACTIVE -> ROLLED_BACK` is deliberately absent: an active deployment degrades first, so a rollback records that degradation was observed.
- [x] Serialize evolution/deployment transitions with the writer lease. Every transition holds the deployment `SingleWriterLock`, and taking over an expired lease emits a `lock.recovered` audit event rather than passing silently.
- [x] Verify the artifact checksum and the current baseline before deployment: the artifact's id is recomputed from its body, and activation is refused if the current policy no longer matches the baseline the gate evidence was taken against.
- [x] Add a `SignatureVerifier` seam that fails closed: with no verifier configured, activation is refused rather than permitted.
- [x] Implement canary health checks for quality, error rate, latency, cost, and miss rate (`summarizeCanary`, applied by `DeploymentWriter.completeCanary`); breached thresholds are named, and a breach rolls the deployment back.
- [x] Atomically update the current policy pointer only after canary success. The pointer moves only inside `PolicyRegistry.promotePolicy`, which re-validates the gate, approval, and canary before mutating; a failure before that leaves it untouched.
- [x] Retain at least three stable versions (`stableVersions`) and implement rollback to the previous stable artifact, restoring the pointer only to a registered one.
- [x] Emit approval, deployment, degraded, and rollback audit events to an append-only sink (`InMemoryAuditLog`, `FileAuditLog`), each with a content-hash event id. Degradation during a rollback is its own event, not a footnote on it.

## P2: Tool and Environment Expansion

### 11. Tool Synthesis

- [x] Detect repeated successful subgraphs in Discovery DAGs (`src/tools/subgraph.ts`). Only completed steps count, and a failure splits the run rather than being skipped over, so a sequence spanning a failure is never offered as a tool. A run contributes one occurrence no matter how often it repeats a sequence inside itself, so repetition within a single episode cannot stand in for repetition across runs.
- [x] Generate tool name, version, input/output JSON Schema, source, tests, dependencies, permissions, and a content-addressed artifact hash (`src/tools/synthesized-tool.ts`). The generated module imports nothing, so the dependency allowlist is clean by construction.
- [x] Run synthesized tools through AST, dependency, resource/network capability, and isolated test gates (`src/tools/tool-gate.ts`). The test source is scanned by the same rules, and a tool whose tests cannot run has not passed them. Process isolation only; filesystem and network confinement is still the open sandbox blocker.
- [x] Add Dynamic Tool Registry with enable, disable, version, and rollback (`src/tools/tool-registry.ts`). Enabling requires an operator and a clean gate; a tool with any failed guard cannot be enabled by supplying a different verdict later.
- [x] Ensure disabled tools cannot be selected by new tasks: `selectable()` omits them and `resolve(name)` returns nothing, so a caller filtering by name gets nothing rather than a deprioritised entry.

### 12. Real Simulator Adapter

- [ ] Select first simulator and task family. `[!]`
- [ ] Freeze observation schema, coordinate system, action capability profile, and scoring function. `[!]`
- [ ] Implement one real `EnvironmentAdapter`; `[!]` blocked on the simulator selection. The boundary it requires is in place and now enforced: the SDK is reached only through `embodied/mock-adapter.ts`, the protocol depends on nothing but the core data model, and all three embodied tools take `EnvironmentAdapter` rather than the SDK. `test/architecture.test.mjs` fails if that changes.
- [ ] Add deterministic seed and large-payload artifact capture; both need a simulator that produces randomness or payloads. `reset` and the failure fixtures exist, and disposal now releases every session rather than only closing storage, so an environment is not left holding a pose after unload.
- [x] Keep raw motor/joint control outside the MVP action allowlist. The vocabulary is closed: `checkCapability` denies any action absent from `EMBODIED_ACTION_TYPES`, so a forged capability profile cannot widen it. A future simulator adapter must preserve this.

## P2: Scientific Evaluation and Operations

### 13. Benchmark Protocol

- [ ] Define at least two task families with distinct search-space topology. `[!]`
- [ ] Compare fixed baseline, hand-designed policy, evolved policy, and holdout performance. Needs real task families; producing this comparison from the mock would be exactly the replay-fixture performance claim the blockers forbid.
- [x] Add ablations for boundary penalty, task-level split, cost term, and parallel-efficiency term (`src/evolution/ablation.ts`). Each evaluator term is removed one at a time so its contribution is the delta from baseline, and the task-level split is compared against a node-level one that leaks tasks across partitions. This decomposes a recorded result; it is architecture validation, not a performance claim.
- [x] Report per-task-family quality, cost, latency, miss rate, sample count, and 95% confidence intervals (`src/observability/report.ts`, `src/observability/statistics.ts`). Small samples use a Student-t critical value, and a single sample reports no interval rather than a zero-width one. Real multi-family evidence still needs the benchmark below.
- [ ] Test cross-task transfer and quantify transfer degradation. Needs at least two task families.
- [x] Replace provisional paper references with verified bibliographic citations. Reference [1] in TECHNICAL_PAPER.md now cites Zheng et al., "Dream-RSI: Recursive Self-Improvement through Evolving Worlds", arXiv:2609.14858, whose abstract describes the replay-simulator-over-discovery-trees mechanism this implementation realizes. Identified from that description rather than supplied by the authors, so it is flagged in the document for confirmation.

### 14. Observability and Failure Injection

- [x] Add correlation-aware metrics for task, episode, policy, evaluation, and deployment (`src/observability/metrics.ts`). Every sample carries the identifiers tying it to its run, so a number can be traced rather than only aggregated; non-finite values are refused. Per-task model tokens, latency, retries, and failures come from the recording LLM adapter.
- [x] Add audit trail for approval, deployment, rollback, lock recovery, and emergency stop. The event now names a `subject` (deployment, session, or tool), so one append-only trail covers policy and action-safety events.
- [x] Add machine-readable Q/C/P/M/S reports (`src/observability/report.ts`), per evaluation and broken down by task family, alongside deployment history and metric summaries.
- [x] Inject provider outage, worker crash, stale lease, corrupted artifact, timeout, cancellation, and rollback failures (`test/failure-injection.test.mjs`); each asserts which state must be left untouched, not only that an error surfaced.
- [x] Verify online task execution continues when offline evolution fails: an episode completes, a generation attempt fails, and a second episode completes with the registry exactly as the outage left it.

### 15. Privacy and Governance

- [x] Define observation/artifact retention and deletion policy (`src/governance/retention.ts`): retention is decided per artifact kind at write time, a caller cannot shorten it, and policy/tool/evaluation artifacts are retained indefinitely because they are the audit trail. Deletion stays an explicit operator act.
- [x] Add secret redaction and sensitive prompt/tool-output handling (`src/governance/redaction.ts`), applied to audit reasons before they are stored and hashed, and available as `redactValue` for any structure that leaves the trust boundary. Recorded ground truth is deliberately not redacted: replay must reproduce it.
- [x] Define access control for evolve, approve, deploy, rollback, and tool approval (`src/governance/access-control.ts`), deny by default, enforced on every governed deployment transition, with approval and deployment as separate grants and a check that a writer cannot record an approval made under another principal.
- [ ] Review high-risk embodied actions with a human safety owner. `[!]` Needs a named person; the capability profile and confirmation gate are ready for that review.
- [x] Document the production approval policy (`PRODUCTION_POLICY.md`) and keep auto-deploy disabled unless explicitly approved. The policy's safety defaults are a machine-readable block that a test compares against `resolveDreamRsiConfig({})`, so the document cannot drift from the code.

## Release Blockers

The project is not ready for production pilot until all of these have evidence:

- [x] Verified target DSH profile/patch integration (DSH 0.1.5-rc.1, `@deepseek-ai/cordis-plugin-loader@1.0.3`; see BASELINE.md), including the bundle patch without which a profile cannot mount the package. Covered by `test/adapter-compat.test.mjs`.
- [x] Complete task-to-Discovery-to-Replay-to-evaluation trace, verified against the mock environment (`test/end-to-end.test.mjs`). Real-simulator evidence is still tracked under item 10.
- [ ] Strong OS/container isolation for untrusted candidate code.
- [ ] Immutable signed policy/evaluation/snapshot artifacts.
- [ ] AST, dependency, resource, and network guards. Static guards for all four exist and are tested, and runtime filesystem writes and process spawning are denied by Node's permission model. Runtime CPU, memory, and network limits do not, so this stays open.
- [ ] Holdout gate with sufficient samples and per-task-family report. The gate, the sample floor, and the per-family verdict all exist and are tested, but the only evidence is a synthetic mock family; real evidence needs the simulator (item 12).
- [x] Approval, canary, atomic deployment, and rollback (`src/registry/deployment-writer.ts`, 15 tests). Signature verification is still missing and is tracked under the signed-artifacts blocker below.
- [x] Action state machine with emergency-stop and no retry after stop (`src/safety/action-state.ts`, `src/safety/action-guard.ts`).
- [x] Audit, retention, deletion, and secret-redaction controls. Audit is append-only with content-hash event ids (`src/registry/audit.ts`); retention is per artifact kind and cannot be shortened by a caller, with deletion metadata and an operator-triggered prune (`src/governance/retention.ts`, `src/artifacts/store.ts`); redaction covers provider keys, bearer tokens, JWTs, credential assignments, and URL credentials, applied to audit reasons before storage (`src/governance/redaction.ts`).
- [ ] Multi-task benchmark evidence; no performance claim based only on replay fixtures.

## Recommended Execution Order

1. Profile/patch adapter and host configuration schema.
2. End-to-end mock task and action safety state machine.
3. Artifact store and snapshot transaction integrity.
4. Strong evaluator isolation and guardrails.
5. Policy/evaluation/deployment artifact models.
6. Evaluate-only candidate generation.
7. Monotonic gate integration with holdout reports.
8. Approval, canary, rollback, and audit.
9. Tool synthesis and dynamic registry.
10. Real simulator adapter and multi-task benchmark.

Every item should add focused tests, update the relevant design/technical paper section, and end with a small commit. Do not enable automatic deployment while any release blocker remains open.
