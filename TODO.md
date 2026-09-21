# Dream-RSI Harness TODO

**更新日期**：2026-09-21  
**目前 baseline**：57 tests passing，`main` 已推送至 GitHub  
**原則**：先完成可驗證的安全邊界，再開啟 candidate generation 或自動部署。

## Status Legend

- `[x]` 已完成並有測試或文件證據
- `[ ]` 尚未完成
- `[!]` release blocker 或需要外部決策

## Completed Baseline

- [x] 固定 Node.js >=22.5、TypeScript、Cordis 與 DSH tools 版本
- [x] Cordis `apply(ctx, config?)` plugin entrypoint
- [x] `ctx.effect()` reversible tool registration/disposal
- [x] Mock embodied backend 與 per-session state isolation
- [x] `embodied_perceive`、`embodied_act`、`embodied_query_state`
- [x] `embodied_act` 逾時與取消對非同步 backend 真正生效（backend 可注入延遲並回應 `AbortSignal`，逾時/取消都不會讓 state 被 mutate）
- [x] Typed embodied action events
- [x] In-memory 與 SQLite Discovery Store
- [x] Discovery idempotency key 與 duplicate retry protection
- [x] Canonical ReplayKey 與 deterministic Replay Simulator
- [x] Boundary miss 與 counterfactual replay behavior
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
- [x] Verify that tool, event, service, command, and worker registrations leave no residue after disposal.
- [x] Ship the bundle patch (`cordis.patch.yml` plus `dsh.bundle.patch`), without which a profile cannot mount the package at all.

### 2. Configuration and Runtime Wiring

- [x] Add typed configuration defaults and validation.
- [x] Add configuration schema export for the host Harness (`Config`, Schemastery; the Cordis loader validates each fiber's `config` against it before `apply` runs).
- [x] Connect validated config to Discovery store, embodied backend, split config, and writer lock construction (`src/runtime.ts`).
- [ ] Derive replay and evaluator settings (`replay.maxNodes`, `replay.missRateMax`, `evaluation.timeoutMs`, `evaluation.minimumHoldoutSamples`) in the runtime. Deferred until the end-to-end pipeline consumes them.
- [x] Add `dream status` read-only runtime facade (exposed as the `dream_status` tool, since no verified Cordis/DSH command contract exists yet; see `src/status.ts`).
- [x] Reject invalid configuration before any persistent resource or tool registration is created (the schema runs in `apply` before `ctx.effect`; `createDreamRsiRuntime` validates before opening SQLite).

### 3. End-to-End Mock Task

- [ ] Define `Task`, `Episode`, `Observation`, `ActionRequest`, and `ActionResult` schemas.
- [ ] Execute one complete mock task through perceive -> policy/tool action -> result -> Discovery node.
- [ ] Link task, episode, session, policy version, correlation ID, and action ID in every trace.
- [ ] Run the same episode through snapshot -> Replay -> evaluator.
- [ ] Add success, failure, timeout, cancellation, and emergency-stop fixtures.

## P1: Safety and Evaluation Readiness

### 4. Action Safety Contract

- [ ] Implement capability profiles for sensors, actions, coordinate frames, limits, and risk levels.
- [ ] Implement action state machine: `REQUESTED -> AUTHORIZED -> EXECUTING -> terminal`.
- [ ] Add action lease, session mutex, idempotency, rate limit, timeout, cancellation, and emergency stop.
- [ ] Prohibit automatic retry after emergency stop.
- [ ] Add authorization and high-risk confirmation tests.

### 5. Artifact and Snapshot Integrity

- [x] Align `DiscoveryNode` with the detailed design schema (`schemaVersion`, `createdAt`, optional `sessionId`/`episodeStep`/`correlationId`/`criticalPathMs`) and persist all fields in the SQLite store.
- [ ] Implement content-addressed artifact store with SHA-256, schema version, byte length, retention, and deletion metadata.
- [ ] Materialize ReplaySnapshot from a consistent SQLite read transaction.
- [x] Decided: snapshot identity includes `createdAt` (content hash covers `schemaVersion` + `createdAt` + `splits`; see `src/evolution/snapshot.ts`).
- [ ] Add artifact checksum verification before evaluation and deployment.
- [ ] Add signature provider, verification, key rotation, and failure tests. `[!]`

### 6. Strong Evaluator Isolation

- [x] Process boundary and timeout wrapper.
- [ ] Add cancellation and process-group termination.
- [ ] Add output schema validation and bounded stdout/stderr.
- [ ] Add CPU, memory, process-count, wall-time, filesystem, and network limits.
- [ ] Select and implement container or OS-level sandbox before running untrusted candidate code. `[!]`
- [ ] Ensure holdout, evaluator internals, secrets, and deployment registry are inaccessible to candidates.

### 7. Guardrails

- [x] Implement AST guard for forbidden calls and dynamic imports (`src/guardrails/ast-guard.ts`, rule-based on the TypeScript compiler AST; not a full sandbox).
- [ ] Implement dependency/import allowlist.
- [ ] Implement resource and network capability guard.
- [ ] Add prompt-injection and malicious tool-output fixtures.
- [ ] Verify every guard rejection leaves current policy and deployment registry unchanged.

## P1: Evolution and Deployment

### 8. Immutable Policy and Evaluation Artifacts

- [ ] Define `PolicyArtifact`, `EvaluationReport`, `Deployment`, `Approval`, and `CanaryResult` models.
- [ ] Add source hash, parent version, evaluator version, snapshot ID, config hash, and dependency manifest.
- [ ] Add immutable artifact registry and current-policy pointer.
- [ ] Add report persistence and rejection reasons by case/task family.

### 9. Candidate Generation

- [ ] Build Evolution Agent adapter using only the Harness LLM facade.
- [ ] Restrict candidate mutations to scheduling, pruning, retry, parallelism, and budget logic.
- [ ] Keep holdout data, evaluator internals, secrets, and deployment state outside candidate input.
- [ ] Add evaluate-only candidate generation; do not enable deployment by default.
- [ ] Add deterministic seed and reproducible build identifier.

### 10. Deployment, Canary, and Rollback

- [ ] Implement deployment state machine: `PROPOSED -> APPROVED -> CANARY -> ACTIVE`.
- [ ] Serialize evolution/deployment transitions with the writer lease.
- [ ] Verify artifact checksum/signature and current baseline before deployment.
- [ ] Implement canary health checks for quality, error rate, latency, cost, and miss rate.
- [ ] Atomically update current policy pointer only after canary success.
- [ ] Retain at least three stable versions and implement rollback.
- [ ] Emit approval, deployment, degraded, and rollback audit events.

## P2: Tool and Environment Expansion

### 11. Tool Synthesis

- [ ] Detect repeated successful subgraphs in Discovery DAGs.
- [ ] Generate tool name, version, JSON Schema, source, tests, dependencies, permissions, and artifact hash.
- [ ] Run synthesized tools through AST, dependency, resource, and isolated test gates.
- [ ] Add Dynamic Tool Registry with enable, disable, version, and rollback.
- [ ] Ensure disabled tools cannot be selected by new tasks.

### 12. Real Simulator Adapter

- [ ] Select first simulator and task family. `[!]`
- [ ] Freeze observation schema, coordinate system, action capability profile, and scoring function. `[!]`
- [ ] Implement one `EnvironmentAdapter` without leaking simulator SDK types into core.
- [ ] Add simulator reset, deterministic seed, artifact capture, and failure fixtures.
- [ ] Keep raw motor/joint control outside the MVP action allowlist.

## P2: Scientific Evaluation and Operations

### 13. Benchmark Protocol

- [ ] Define at least two task families with distinct search-space topology. `[!]`
- [ ] Compare fixed baseline, hand-designed policy, evolved policy, and holdout performance.
- [ ] Add ablations for boundary penalty, task-level split, cost term, and parallel-efficiency term.
- [ ] Report per-task-family quality, cost, latency, miss rate, sample count, and confidence intervals.
- [ ] Test cross-task transfer and quantify transfer degradation.
- [ ] Replace provisional paper references with verified bibliographic citations. `[!]`

### 14. Observability and Failure Injection

- [ ] Add correlation-aware metrics for task, episode, policy, evaluation, and deployment.
- [ ] Add audit trail for approval, deployment, rollback, lock recovery, and emergency stop.
- [ ] Add dashboards or machine-readable reports for Q/C/P/M/S.
- [ ] Inject provider outage, worker crash, stale lease, corrupted artifact, timeout, cancellation, and rollback failures.
- [ ] Verify online task execution continues when offline evolution fails.

### 15. Privacy and Governance

- [ ] Define observation/artifact retention and deletion policy.
- [ ] Add secret redaction and sensitive prompt/tool-output handling.
- [ ] Define access control for evolve, approve, deploy, rollback, and tool approval.
- [ ] Review high-risk embodied actions with a human safety owner.
- [ ] Document production approval policy; keep auto-deploy disabled unless explicitly approved.

## Release Blockers

The project is not ready for production pilot until all of these have evidence:

- [ ] Verified target DSH profile/patch integration.
- [ ] Complete task-to-Discovery-to-Replay-to-evaluation trace.
- [ ] Strong OS/container isolation for untrusted candidate code.
- [ ] Immutable signed policy/evaluation/snapshot artifacts.
- [ ] AST, dependency, resource, and network guards.
- [ ] Holdout gate with sufficient samples and per-task-family report.
- [ ] Approval, canary, atomic deployment, and rollback.
- [ ] Action state machine with emergency-stop and no retry after stop.
- [ ] Audit, retention, deletion, and secret-redaction controls.
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
