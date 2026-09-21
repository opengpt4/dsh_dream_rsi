# Dream-RSI DeepSeek Harness Plugin Project Plan

**版本**：0.1
**日期**：2026-09-18
**狀態**：Implementation plan
**基準規格**：[FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md)
**技術基線**：[BASELINE.md](BASELINE.md)

## 1. Project Charter

### 1.1 目標

建立一個以 DeepSeek Harness 與 Cordis 為執行邊界的 self-improving plugin。底層 DeepSeek model 保持 frozen；可演進的對象是 Harness policy、task orchestration、tool selection、parallel scheduling、pruning、budget allocation 與經審核的 reusable tools。

核心閉環：

```text
Real execution -> Discovery DAG -> Immutable Replay Snapshot
      -> Offline evaluation -> Safety gates -> Canary/approval -> Deployment
      -> More real execution
```

### 1.2 Success definition

MVP 完成必須同時滿足：

- Cordis plugin 可掛載、可卸載，所有 tool/event/service registration 可逆清理。
- 真實或 mock embodied episode 可形成可查詢、可冪等寫入的 Discovery DAG。
- Replay 不呼叫 LLM、不執行外部 sandbox，且相同 snapshot/policy/seed 結果可重現。
- Candidate evaluation 具備 train/validation/holdout split、Q/C/P/M 指標與單調 gate。
- Candidate 不可直接部署；必須通過 code/security/resource checks、holdout、canary 與設定的 approval policy。
- Evolution/deployment writer 具備 lease、heartbeat、取消與 recovery 行為。
- 線上 execution 與離線 evolution 故障隔離。
- 所有 policy、tool、snapshot、evaluation report 與 deployment 都可追溯、可回滾。

## 2. Scope

### 2.1 In scope

- TypeScript ESM plugin，Node >=22.5。
- `@deepseek-ai/cordis@4.0.2`、`@deepseek-ai/dsh-tools@0.1.5-rc.2` 相容 adapter。
- embodied `perceive`、`act`、`query-state` tools 與 typed events。
- per-session backend context、capability profile 與 action safety state machine。
- Discovery repository，MVP 使用 SQLite。
- canonical ReplayKey、deterministic Replay Simulator、counterfactual branch。
- immutable evaluation snapshot、process-isolated evaluator、split、monotonic gate。
- policy artifact registry、approval、canary、deployment、rollback。
- AST/resource/network guard 與 audit/metrics。
- evaluate-only 預設模式；自動部署必須明確開啟。

### 2.2 Out of scope for MVP

- 修改或微調 DeepSeek weights。
- 直接控制 raw motor/joint velocity、未封裝硬體通道。
- 將歷史自然語言摘要自動轉成不可逆 pruning rule。
- 以 replay 預測歷史資料邊界外的未知結果。
- production-grade container orchestration、distributed Postgres writer queue、完整 Web UI。
- 沒有安全審核的 autonomous tool synthesis。

## 3. Current Baseline

已完成並已測試的實作：

| Capability | 狀態 | Evidence |
|---|---|---|
| Mock embodied backend 與三個 DSH tools | Done | `src/embodied/`, lifecycle test |
| Typed embodied events | Done | `src/embodied/events.ts` |
| Discovery in-memory/SQLite store | Done | `src/discovery/` |
| ReplayKey 與 deterministic simulator | Done | `src/replay/` |
| Q/C/P/M evaluator | Done | `src/evolution/evaluator.ts` |
| Task-level train/validation/holdout split | Done | `src/evolution/split.ts` |
| Strict monotonic gate | Done | `src/evolution/monotonic-gate.ts` |
| Immutable evaluation snapshot | Done | `src/evolution/snapshot.ts` |
| Process-isolated evaluator with timeout | Done | `src/evolution/isolated-evaluator.ts` |
| Lease/heartbeat single writer lock | Done | `src/operations/single-writer-lock.ts` |
| Reversible Cordis tool registration via `adapter/cordis.ts` | Done | `src/adapter/cordis.ts`, lifecycle test |
| Configuration defaults and validation | Done | `src/config.ts`, config tests |
| Read-only `dream_status` tool | Done | `src/status.ts`, status test |
| Minimal AST guard (blocklist on TypeScript AST) | Done | `src/guardrails/ast-guard.ts`, ast-guard test |
| Real profile/patch adapter | Not started | Depends on selected DSH profile contract |
| Candidate generation, dependency allowlist, deployment registry | Not started | Next implementation track |

Current verified suite: `npm run typecheck` and `npm test`; latest implementation suite has 477 passing tests. The process evaluator is a process boundary, not yet a complete filesystem/network/resource sandbox. The AST guard is a syntax-level blocklist, not a substitute for OS/container isolation of untrusted candidate code.

## 4. Delivery Strategy

Use vertical slices. Each slice must include implementation, focused tests, documentation update, and a commit. No candidate generation or autonomous deployment is enabled before the corresponding guard and rollback gates exist.

### Phase 0 - Contract freeze and repository hygiene

**Outcome**: Stable interfaces and reproducible local build.

Work packages:

- Freeze Node, TypeScript, DSH and Cordis versions.
- Add config schema and validation with explicit defaults.
- Define artifact naming, schema versions, source hashes and correlation IDs.
- Add test fixtures for success, boundary miss, timeout, cancellation, quality regression and stale lease.
- Add CI checks for typecheck, build, tests and clean generated output.

Exit gate:

- A new checkout can install, build and run the complete test suite without network services or secrets.
- Invalid config fails before plugin registration.

### Phase 1 - Plugin lifecycle and profile integration

**Outcome**: Production-shaped Cordis mounting boundary.

Work packages:

- Implement `adapter/cordis.ts` for `apply`, `ctx.effect`, service registration and disposal.
- Define plugin manifest/profile example and `cordis.patch.yml` example based on the verified DSH runtime contract.
- Register configuration schema and capability metadata.
- Add `dream status` read-only command facade.
- Test mount, duplicate mount, dispose, failed setup and partial registration cleanup.

Dependencies: Phase 0 and verified DSH profile/patch API.

Exit gate:

- Plugin mount and dispose leave no tool/event/service registration.
- A profile can enable/disable the plugin without editing core Harness code.

### Phase 2 - Online execution and embodied contract

**Outcome**: One end-to-end task produces a complete episode and Discovery DAG.

Work packages:

- Define `Task`, `Episode`, `Observation`, `ActionRequest`, `ActionResult` schemas.
- Add EnvironmentAdapter with `observe`, `availableActions`, `execute`, `reset`.
- Add capability profile enforcement and high-level action allowlist.
- Implement action state machine: `REQUESTED -> AUTHORIZED -> EXECUTING -> terminal`.
- Add lease, idempotency key, session mutex, timeout, cancel and emergency-stop behavior.
- Connect Harness LLM calls and tool calls to node recording.

Dependencies: Phase 1, DSH tool/runtime contract.

Exit gate:

- Success, reject, timeout, cancel and emergency-stop paths produce terminal state and audit event.
- Two sessions cannot observe or mutate each other's backend state.
- Every action and model request is linked by task, episode and correlation IDs.

### Phase 3 - Discovery storage and replay assets

**Outcome**: History becomes an immutable, deterministic offline world.

Work packages:

- Complete SQLite schema/indexes for tasks, episodes, nodes, artifacts and idempotency.
- Add artifact store references with checksum, schema version, retention and deletion policy.
- Materialize `ReplaySnapshot` from a consistent read transaction.
- Validate ReplayKey normalization and snapshot hash.
- Implement counterfactual branch enumeration and boundary-miss reporting.
- Add replay purity tests that fail on LLM, sandbox or network access.

Dependencies: Phase 2 and existing store/replay primitives.

Exit gate:

- Replay on identical snapshot is byte/metric deterministic within 1e-6.
- Replay never calls external services.
- Snapshot content cannot change after evaluation starts.

### Phase 4 - Isolated evaluation and reliability gates

**Outcome**: Candidate evaluation is reproducible and cannot mutate evaluator inputs.

Work packages:

- Wrap evaluator execution in a worker process with timeout, cancellation and structured errors.
- Add resource controls: CPU/time/memory/output limits; move to container or OS sandbox before untrusted candidate execution.
- Finalize train/validation/holdout task split and holdout access restrictions.
- Produce signed evaluation report with evaluator version, source hash, snapshot hash and config hash.
- Extend monotonic gate with per-task-family reports, minimum sample count, confidence interval and budget checks.
- Connect evolution/deployment writer lock to job lifecycle and recovery.

Dependencies: Phase 3, immutable snapshots and writer lease.

Exit gate:

- Worker timeout cannot leave a running evaluator process.
- Candidate cannot modify snapshot, holdout, evaluator or deployment registry.
- A rejected candidate produces a reasoned report and no deployment mutation.

### Phase 5 - Policy evolution, artifacts and deployment

**Outcome**: Safe evaluate-only evolution and controlled canary deployment.

Work packages:

- Define PolicyVersion immutable artifact and parent lineage.
- Build Evolution Agent adapter through the Harness LLM facade only.
- Restrict candidate changes to declared policy modules and approved dependencies.
- Implement AST/import/resource guard and candidate build verification.
- Add deployment registry, approval record, canary runner, hot-swap and rollback.
- Implement `dream evaluate`, `dream evolve`, `policy show/list/rollback` with authorization.
- Keep auto-deploy disabled by default.

Dependencies: Phase 4 and verified Harness LLM adapter.

Exit gate:

- Candidate generation never writes directly to current policy.
- Only an immutable, checksum-verified artifact can enter canary.
- Failed guard, gate, approval, canary or health check leaves current policy unchanged.
- Rollback restores a known stable version and emits audit events.

### Phase 6 - Tool synthesis and embodied adapters

**Outcome**: Controlled skill-library growth and real simulator adapter.

Work packages:

- Extract repeated successful subgraphs into tool candidates.
- Generate schema, implementation, tests, dependency manifest and permissions.
- Run tests/AST/resource checks in isolated runner.
- Add Dynamic Tool Registry with enable/disable/version/rollback.
- Add one simulator adapter and capability profile; keep hardware behind backend interface.
- Add observation artifact lifecycle and redaction.

Dependencies: Phase 5, stable action contract and artifact store.

Exit gate:

- Synthesized tools require approval or explicit policy.
- Disabled tools cannot be selected by new tasks.
- High-risk actions remain confirmation-gated.

### Phase 7 - Evaluation, operations and scale

**Outcome**: Multi-task operational confidence.

Work packages:

- Add benchmark families with cross-task transfer fixtures.
- Add shadow/canary metrics, dashboards and alert thresholds.
- Add worker queue and Postgres repository only when SQLite limits are demonstrated.
- Perform failure injection for provider outage, worker crash, stale lease, corrupted artifact and rollback.
- Security review and threat-model refresh.

Exit gate:

- Evidence shows no quality regression on holdout, bounded cost, acceptable failure recovery and auditable deployment history.

## 5. Release Gates

### Development gate

- `npm run typecheck`
- `npm test`
- No new diagnostics.
- Focused tests cover new behavior.

### Candidate gate

- Source/artifact checksum and dependency manifest verified.
- AST/import/resource/network checks pass.
- Train/validation/holdout membership and snapshot hash match.
- Process/container evaluator completes within budgets.

### Deployment gate

- Candidate case set matches current case set.
- Configured pass ratio, minimum improvement, miss rate and resource limits pass.
- Approval requirement satisfied.
- Canary health check passes.
- Deployment writer lease held and audit event written.

### Rollback gate

- Health threshold breach or explicit operator request identifies target stable version.
- Target artifact checksum is verified.
- Rollback is serialized under deployment lock.
- Current version remains available until replacement is healthy.

## 6. Risks and Mitigations

| Risk | Impact | Mitigation | Owner milestone |
|---|---|---|---|
| Replay boundary bias | Candidate overfits history | Boundary penalty, holdout, real exploration | Phase 3-4 |
| Candidate code escape | Host/data compromise | AST plus process/container sandbox, no secrets | Phase 4-5 |
| Semantic guidance reduces diversity | Search regression | Evolve control flow/data structures, avoid text pruning rules | Phase 5 |
| Stale writer after crash | Evolution/deploy blocked | Lease, heartbeat, expiry recovery, audit | Phase 4 |
| Artifact mutation after evaluation | Invalid comparison | Immutable snapshot/hash/signature | Policy artifacts and evaluation reports signed (Ed25519, PEM key ring) and verified at activation; snapshot signing pending |
| Cross-task overfitting | Poor generalization | Task-level split and multiple task families | Phase 7 |
| DSH preview API changes | Integration breakage | Adapter layer, pinned versions, compatibility tests | Phase 0-1 |
| Embodied action hazard | Physical or simulated damage | Capability profile, confirmation, timeout, emergency stop | Phase 2/6 |
| Cost runaway | Budget exhaustion | Per-task and worker budgets, monotonic cost gate | Phase 4-5 |

## 7. Team and Workstream Boundaries

- **Runtime/Adapter**: Cordis lifecycle, DSH integration, commands and configuration.
- **Embodied**: backend, capability profile, action state machine and event contract.
- **Data/Replay**: repository, artifacts, snapshot and simulator.
- **Evolution/Safety**: evaluator, split, guards, candidate generation and monotonic gate.
- **Operations**: leases, deployment, canary, rollback, audit and metrics.
- **Validation**: fixtures, benchmark families, failure injection and compatibility tests.

A single developer may implement these sequentially, but each workstream should expose contracts before implementation to keep the core independent of DSH and simulator details.

## 8. Immediate Next Actions

1. Add config schema and validation with `evaluate-only` and `embodied.enabled=false` defaults.
2. Implement profile/patch adapter tests against the pinned Cordis runtime.
3. Extend process evaluator with cancellation and resource limits.
4. Define immutable `PolicyVersion`, `EvaluationReport` and `Deployment` artifact models.
5. Add AST/import guard before implementing candidate generation.
6. Build one end-to-end mock task from `embodied_perceive` through Discovery, Replay and evaluation.

## 9. Definition of Done

The project is ready for production pilot only when all of the following have evidence in tests or operational reports: reproducible build; reversible plugin lifecycle; complete task trace; deterministic replay; isolated evaluator; signed immutable artifacts; monotonic holdout gate; approval/canary/rollback; action safety state machine; audit/metrics; failure recovery; and a documented simulator capability profile.
