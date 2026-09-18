# DSH Technical Baseline

## Verified

- DSH CLI: `@deepseek-ai/dsh@0.1.5-rc.2`
- Cordis peer: `@deepseek-ai/cordis@4.0.2`
- Node runtime: `>=22.5` (local verification: Node 24.20.0; required for `node:sqlite`)
- Plugin entry contract verified from `@deepseek-ai/dsh-tool-cordis`: `apply(ctx: Context): void`
- DSH packages use ESM and expose TypeScript declarations.

## Not Assumed Yet

The published minimal SDK bundle is a profile bundle, not a plugin registration API. Tool, event, and service registration must be implemented only after the exact DSH packages and runtime contracts are selected and tested.

The local plugin entry now registers the verified `embodied_perceive` tool through `ctx.tools.register(defineTool(...))`. Its mock backend isolates state by an explicit `session_id` because the verified tool execution context does not expose a session service directly.

The plugin now also registers `embodied_act` and `embodied_query_state`. `embodied_act` is limited to high-level mock primitives, observes the verified DSH cancellation signal, and emits typed started/completed/frame/error events. The package also exports a deterministic ReplayKey, `ReplaySimulator`, idempotent Discovery Stores, a normalized Q/C/P/M evaluator, a process-isolated evaluator runner with timeout, task-level train/validation/holdout splitting, a strict Monotonic Gate, immutable evaluation snapshots, and a single-writer lock.

The split keeps all nodes for one task in one partition. The gate requires matching case sets, configurable quality pass ratio, and minimum score improvement. Snapshot freezing protects in-process evaluation inputs, while the isolated runner moves evaluation into a child process with a timeout. This is not yet a resource/network/filesystem sandbox for untrusted candidate code. Reversible tool lifecycle cleanup is covered; full profile/patch integration, stronger sandboxing, and a real simulator adapter remain future work.
