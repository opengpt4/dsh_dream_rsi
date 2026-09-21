# Dream-RSI DeepSeek Harness Plugin

Cordis plugin architecture for self-improving DeepSeek Harness policies. The
model remains frozen; the system evolves orchestration policy and approved
tools through deterministic replay, isolated evaluation, and safety-gated
deployment.

## Documentation

- [Functional specification](FUNCTIONAL_SPEC.md)
- [Project plan](PROJECT_PLAN.md)
- [Detailed design specification](DETAILED_DESIGN_SPEC.md)
- [Technical paper](TECHNICAL_PAPER.md)
- [Implementation baseline](BASELINE.md)

## Current baseline

Implemented and tested capabilities include:

- Cordis reversible embodied tool registration behind a dedicated `adapter/cordis.ts` boundary, with the
  `tools` service declared in `inject` so activation cannot race its provider
- bundle patch and `dsh.bundle.patch` manifest, so a profile can mount the package
- host-facing `Config` schema, validated by the Cordis loader before `apply` runs
- runtime binding validated config to the Discovery store, embodied backend, split config, and writer locks
- session-isolated mock embodied backend and typed events, with real async timeout/cancellation
- enforced architecture boundaries: the simulator SDK is reached only through its adapter, and only the
  adapter calls the Cordis registration API
- `embodied_perceive` reports the coordinate frame and schema version with every observation, accepts
  `sensor_types`/`include_pose`, and refuses a sensor the backend never declared
- environment protocol (`Observation`, `ActionRequest`, `ActionResult`) and a mock adapter that resolves
  every attempt to a terminal status and latches a stopped session until reset
- end-to-end episode runner recording one Discovery node per step, including failed, timed-out, and
  cancelled attempts, with task, episode, session, policy, correlation, and action IDs on every node
- episode pipeline: snapshot -> replay -> evaluator, applying the runtime's derived replay and
  evaluation ceilings
- action safety contract: capability profile, `REQUESTED -> AUTHORIZED -> EXECUTING -> terminal` state machine,
  per-session mutex, rate limit, idempotency, lease, confirmation, and an emergency-stop latch that forbids retry
- every action dispatch, from `embodied_act` and from an episode, passes through that contract
- idempotent in-memory and SQLite Discovery stores, with a transactional whole-tree read for snapshots
- immutable policy registry: content-addressed `PolicyArtifact`, `EvaluationReport`, and `Deployment` records,
  a current-policy pointer that moves only behind an approval, a passing evaluation, and a passing canary,
  and a file store that re-verifies every record on load
- evaluation reports persisted per run, with rejection reasons summarised by task family
- correlation-aware metrics and a machine-readable Q/C/P/M/S report per evaluation and task family, with
  95% confidence intervals and a Student-t correction for small samples
- policy artifacts reference their stored source by content, verified separately from the artifact id
- replay purity: the replay modules reach no model client, tool, sandbox, or network capability, and
  leave the source store untouched
- governance: deny-by-default access control on every governed transition, secret redaction at the
  operator-facing boundary, per-kind artifact retention, and a production approval policy checked
  against the running configuration
- one append-only audit trail covering policy deployment and action-safety events
- failure-injection coverage for provider outage, worker crash, stale lease, corrupted artifact,
  timeout, cancellation, and rollback failure
- tool synthesis from repeated successful action sequences, with content-addressed artifacts, permissions
  limited to high-level action primitives, AST/dependency/capability gates plus process-isolated test
  execution, and a dynamic registry where disabled tools are unselectable
- deployment state machine under a writer lease: propose, approve, canary, activate, degrade, roll back,
  with a checksum and baseline check before activation, canary thresholds, rollback to the previous stable
  version, and an append-only audit trail
- evaluate-only candidate generation over the Harness LLM facade: mutation classes restricted to
  scheduling, pruning, retry, parallelism, and budget; a prompt projected from named fields so holdout,
  evaluator internals, secrets, and deployment state cannot leak into it; and a reproducible build id
- content-addressed artifact store: SHA-256 addressed blobs, kind/media type/schema/byte-length metadata,
  retention and deletion recorded out of band, checksum re-verification, and fail-closed verification
  before evaluation
- canonical ReplayKey and deterministic counterfactual replay: recorded alternatives for one state are
  resolved from history, with parameters, so comparing them costs no model call
- a recording LLM adapter that keeps request/response hashes, token usage, latency, and retry counts, and
  emits per-task token, latency, retry, and failure metrics
- Q/C/P/M evaluation, task-level data splits, and monotonic gating
- ablation study over the evaluator terms and the split strategy, reporting each term's contribution
  and the task leakage a node-level split would introduce
- holdout gate over two evaluation reports: holdout-only and same-configuration requirements, independent
  quality/cost/parallel/miss-rate/sample budgets, candidate guard failures, and per-task-family verdicts,
  with a passing verdict required before any promotion
- immutable evaluation snapshots
- process-isolated evaluator with timeout, and Node's permission model applied to every isolated child by
  default: reads scoped to the child's own directory, writes and child processes denied
- lease-based single-writer lock with heartbeat and stale-lock recovery
- validated configuration with evolution and auto-deployment disabled by default, including the holdout
  gate's non-regression ratio and minimum improvement
- `embodied.allowActions` narrows the declared action set; configuration can tighten a deployment but
  never widen it
- read-only `dream_status` tool for enabled capabilities, safety-relevant config, and readiness checks that
  never open storage as a side effect
- disposal releases adapter sessions and guard latches, so an environment is not left holding a pose
- import and capability allowlist, composed with the AST guard into a candidate gate that the pipeline
  enforces before running anything; a capability-granting built-in cannot be allowlisted
- evaluator isolation: own process group killed on deadline, cancellation, or output overflow, a
  `PATH`-only environment, bounded stdout/stderr, and a result rebuilt from untrusted JSON

```bash
npm ci
npm run typecheck
npm test
```

`tsconfig.json` enables `noUnusedLocals` and `noUnusedParameters`, so a value that is accepted and never read fails the build rather than shipping.

The current suite contains 343 passing tests. OS/container sandboxing and a real
simulator adapter remain planned work.

Replaying an episode's own recorded decisions is a determinism check, not
generalization evidence: every replayed decision was recorded from the state it
is replayed against. Generalization needs holdout tasks the policy never saw,
which the multi-task benchmark is what produces.

The plugin is mounted on a real Cordis context in `test/real-cordis-mount.test.mjs`, which is what
exercises the `inject` declaration and the context proxy behind it.

See [examples/](examples/README.md) for mounting the package into a profile. The mounting contract — the
manifest's patch path, the patch row's id and name, and the example override — is checked by
`test/mounting-contract.test.mjs`, so a rename fails a test instead of silently breaking mounting.