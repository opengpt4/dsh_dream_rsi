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

- Cordis reversible embodied tool registration behind a dedicated `adapter/cordis.ts` boundary
- bundle patch and `dsh.bundle.patch` manifest, so a profile can mount the package
- host-facing `Config` schema, validated by the Cordis loader before `apply` runs
- runtime binding validated config to the Discovery store, embodied backend, split config, and writer locks
- session-isolated mock embodied backend and typed events, with real async timeout/cancellation
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
- content-addressed artifact store: SHA-256 addressed blobs, kind/media type/schema/byte-length metadata,
  retention and deletion recorded out of band, checksum re-verification, and fail-closed verification
  before evaluation
- canonical ReplayKey and deterministic counterfactual replay
- Q/C/P/M evaluation, task-level data splits, and monotonic gating
- immutable evaluation snapshots
- process-isolated evaluator with timeout
- lease-based single-writer lock with heartbeat and stale-lock recovery
- validated configuration with evolution and auto-deployment disabled by default
- read-only `dream_status` tool for enabled capabilities and safety-relevant config
- import and capability allowlist, composed with the AST guard into a candidate gate that the pipeline
  enforces before running anything; a capability-granting built-in cannot be allowlisted
- evaluator isolation: own process group killed on deadline, cancellation, or output overflow, a
  `PATH`-only environment, bounded stdout/stderr, and a result rebuilt from untrusted JSON

```bash
npm ci
npm run typecheck
npm test
```

The current suite contains 151 passing tests. OS/container sandboxing, candidate
generation, canary deployment, tool synthesis, and a real simulator adapter
remain planned work.

Replaying an episode's own recorded decisions is a determinism check, not
generalization evidence: every replayed decision was recorded from the state it
is replayed against. Generalization needs holdout tasks the policy never saw,
which the multi-task benchmark is what produces.

See [examples/](examples/README.md) for mounting the package into a profile.