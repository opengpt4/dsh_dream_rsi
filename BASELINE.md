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

The plugin now also registers `embodied_act` and `embodied_query_state`. `embodied_act` is limited to high-level mock primitives, observes the verified DSH cancellation signal, and emits typed started/completed/frame/error events. `MockEmbodiedBackend.execute` is asynchronous and accepts an `AbortSignal`, so a real timeout or an upstream cancellation rejects before any session state mutation runs (verified by dedicated tests), rather than only being observed after a synchronous call already completed. The package also exports a deterministic ReplayKey, `ReplaySimulator`, idempotent Discovery Stores, a normalized Q/C/P/M evaluator, a process-isolated evaluator runner with timeout, task-level train/validation/holdout splitting, a strict Monotonic Gate, immutable evaluation snapshots, and a single-writer lock.

Configuration is now centralized in `src/config.ts`. Defaults keep evolution, auto-deployment, and embodied execution disabled; nested overrides are validated before any Cordis tool registration, including split ratios, resource values, paths, and the requirement that auto-deployment cannot be enabled while evolution is disabled.

All Cordis-specific wiring (`ctx.effect`, `ctx.tools.register`) now lives in `src/adapter/cordis.ts`; `src/index.ts` only validates config and re-exports. The plugin also registers a read-only `dream_status` tool (`src/status.ts`) that reports enabled capabilities and safety-relevant config, standing in for the `dream status` command from FUNCTIONAL_SPEC.md because no verified Cordis/DSH command-registration contract exists in the pinned dependencies. A minimal AST guard (`src/guardrails/ast-guard.ts`) parses candidate source with the TypeScript compiler and rejects `eval`, `new Function`, dynamic `import()`/`require()`, filesystem/network/process built-ins, and `process.env`/`process.exit` access; it is a syntax-level defense-in-depth check, not a replacement for process/container isolation.

The split keeps all nodes for one task in one partition. The gate requires matching case sets, configurable quality pass ratio, and minimum score improvement. Snapshot freezing protects in-process evaluation inputs, while the isolated runner moves evaluation into a child process with a timeout. This is not yet a resource/network/filesystem sandbox for untrusted candidate code. Reversible tool lifecycle cleanup is covered; full profile/patch integration, stronger sandboxing, and a real simulator adapter remain future work.
