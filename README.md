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

- Cordis reversible embodied tool registration
- session-isolated mock embodied backend and typed events
- idempotent in-memory and SQLite Discovery stores
- canonical ReplayKey and deterministic counterfactual replay
- Q/C/P/M evaluation, task-level data splits, and monotonic gating
- immutable evaluation snapshots
- process-isolated evaluator with timeout
- lease-based single-writer lock with heartbeat and stale-lock recovery
- validated configuration with evolution and auto-deployment disabled by default

```bash
npm ci
npm run typecheck
npm test
```

The current suite contains 24 passing tests. Full profile/patch integration,
OS/container sandboxing, candidate generation, canary deployment, tool
synthesis, and a real simulator adapter remain planned work.