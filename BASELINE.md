# DSH Technical Baseline

## Verified

- DSH CLI: `@deepseek-ai/dsh@0.1.5-rc.1` as deployed. The manifest peer range is
  `^0.1.5-rc.1`; `@deepseek-ai/dsh-tools` exports are byte-identical in rc.1 and rc.2.
- Cordis peer: `@deepseek-ai/cordis@4.0.2` (matches the deployed version).
- Schemastery: `@deepseek-ai/schemastery@3.18.2`, which satisfies `StandardSchemaV1`.
- Node runtime: `>=22.5` (local verification: Node 24.20.0; required for `node:sqlite`)
- Plugin entry contract verified from `@deepseek-ai/dsh-tool-cordis`: `apply(ctx: Context): void`
- DSH packages use ESM and expose TypeScript declarations.

### Profile and patch contract

Verified against the deployed Harness and `@deepseek-ai/cordis-plugin-loader@1.0.3`.

- A profile is a directory holding `package.json` and `cordis.patch.yml`. The
  `dsh.profile.bundles` array names the bundle packages; the generated
  `cordis.yml` stays an empty entry list and must not be edited.
- A patch file is a top-level YAML array of entries. `insert:` takes rows typed
  `EntryOptions`: `id` (stable within the tree), `name` (module specifier), and
  optional `config`, `group`, `disabled`, `inject`. Layers compose — each
  bundle's patch, then the profile's `cordis.patch.yml`, then `--patch` overlays
  — and a later layer addresses an earlier row by id, last write per row
  winning. `!!js` expressions are evaluated by the loader.
- `inject` names the services a plugin **waits for**; it does not gate access.
  `ctx.tools` is a Cordis service, and the proxy walks the parent chain looking
  for it, so a provider that installs `tools` before the plugin mounts satisfies
  a plugin that declares nothing. The declaration matters for ordering: with an
  empty list the fiber activates immediately, and if the provider has not run,
  reading `ctx.tools` throws `cannot get property "tools" without inject`.
  Reproduced in `test/real-cordis-mount.test.mjs` by mounting before providing.
  The core mixins (`effect`, `emit`) live on the context prototype rather than
  in the service store, so they need no declaration.
- A package is mountable only when `package.json` declares `dsh.bundle.patch`
  and that path resolves to a patch file. A package listed in
  `dsh.profile.bundles` with no readable patch target never mounts.
- The loader validates each fiber's `config` against the `StandardSchemaV1` a
  plugin exports as `Config` (`Plugin.Runtime.Config`), through `resolveConfig`,
  before `apply` runs. A plugin without a schema receives its config unchanged.
- `ctx.effect(execute, label?)` runs `execute` immediately and takes the
  returned disposer as the rollback. An effect body that throws registers
  nothing, so a partially-completed setup must roll back its own work.

## Simulator environment (verified)

The real-environment path was chosen and checked on this machine, not assumed:

| Fact | Verified how |
|---|---|
| RoboSuite 1.5.2 and MuJoCo 3.2.3 install and import on arm64 macOS | Python 3.11 venv, CPU only, no display, no system packages; about two minutes |
| `Lift` and `Stack` run headless | Both load, reset, step with 7-dimension OSC actions, and close |
| Determinism of the initial state | **Not established.** RoboSuite 1.5.2 exposes no seed API — `env.seed` is `None` and `MujocoEnv` has no `seed` method — so a claimed per-seed reproducibility could not be reproduced and is withdrawn. `deterministic_reset = True` turns placement randomisation off; two runs then agreed, but both read a degenerate zero `cube_pos`, so that is not evidence of a reproducible *meaningful* state either. Making replay reproducible is the recording side's job regardless: a Discovery node carries the state it was taken from. TODO item 152 tracks what replaces the seed. |
| Cameras give large payloads headless | `agentview` RGB 84x84x3 plus 84x84x1 depth with `MUJOCO_GL=glfw`, 49,392 bytes per step, about 1 MB at 512x512 |
| Observations map onto the plugin's protocol | `robot0_eef_pos`/`_quat` is the pose, `robot0_gripper_qpos` the gripper, `cube_pos`/`cubeB_pos`/`cubeA_pos` the objects, and `object-state` is a 10-vector |

Two constraints came out of the check. RoboSuite 1.5.2 fails against MuJoCo 3.13
(`get_joint_qpos_addr` asserts a hinge-or-slide joint and the Panda model presents
a free joint), and its metadata asks for `mujoco>=3.3.0` while 3.2.3 is the
version that works — so the pin is empirical and a future RoboSuite release is
what would lift it. Offscreen rendering needs `MUJOCO_GL=glfw` on macOS; `osmesa`
is not a value this MuJoCo build accepts. The virtual environment lives outside
the repository, so nothing here depends on a committed interpreter.

## Not Assumed Yet

The published minimal SDK bundle is a profile bundle, not a plugin registration API. Tool, event, and service registration must be implemented only after the exact DSH packages and runtime contracts are selected and tested.

The local plugin entry now registers the verified `embodied_perceive` tool through `ctx.tools.register(defineTool(...))`. Its mock backend isolates state by an explicit `session_id` because the verified tool execution context does not expose a session service directly.

The plugin now also registers `embodied_act` and `embodied_query_state`. `embodied_act` is limited to high-level mock primitives, observes the verified DSH cancellation signal, and emits typed started/completed/frame/error events. `MockEmbodiedBackend.execute` is asynchronous and accepts an `AbortSignal`, so a real timeout or an upstream cancellation rejects before any session state mutation runs (verified by dedicated tests), rather than only being observed after a synchronous call already completed. The package also exports a deterministic ReplayKey, `ReplaySimulator`, idempotent Discovery Stores, a normalized Q/C/P/M evaluator, a process-isolated evaluator runner with timeout, task-level train/validation/holdout splitting, a strict Monotonic Gate, immutable evaluation snapshots, and a single-writer lock.

Configuration is centralized in `src/config.ts`. Defaults keep evolution, auto-deployment, and embodied execution disabled, and are derived from the exported `Config` schema so the host view and the defaults cannot drift. Nested overrides are validated before any Cordis tool registration, including split ratios, resource values, paths, and the requirement that auto-deployment cannot be enabled while evolution is disabled; the schema supplies shape and `validateDreamRsiConfig` the cross-field invariants. `src/runtime.ts` binds a validated config to the Discovery store, embodied backend, split config, and writer locks. The store is materialized on first access, so mounting the plugin writes nothing to disk.

All Cordis-specific wiring (`ctx.effect`, `ctx.tools.register`) now lives in `src/adapter/cordis.ts`; `src/index.ts` only validates config and re-exports. The plugin also registers a read-only `dream_status` tool (`src/status.ts`) that reports enabled capabilities, the controls that admit an action, the promotion thresholds, the persisted registry read through a view that creates nothing, the limits the evaluator enforces, and readiness, standing in for the `dream status` command from FUNCTIONAL_SPEC.md because no verified Cordis/DSH command-registration contract exists in the pinned dependencies. A minimal AST guard (`src/guardrails/ast-guard.ts`) parses candidate source with the TypeScript compiler and rejects `eval`, `new Function`, dynamic `import()`/`require()`, filesystem/network/process built-ins, and `process.env`/`process.exit` access; it is a syntax-level defense-in-depth check, not a replacement for process/container isolation.

The split keeps all nodes for one task in one partition. The gate requires matching case sets, configurable quality pass ratio, and minimum score improvement. Snapshot freezing protects in-process evaluation inputs, while the isolated runner moves evaluation into a child process with a timeout. Policy artifacts, evaluation reports, and snapshots carry detached Ed25519 signatures over their ids, verified against an SPKI PEM key ring whose per-key validity windows make rotation non-breaking; activation refuses an unsigned artifact or evidence report, a body that does not match its id, and a key that is absent, out of window, unparseable, or not Ed25519, and names the reason. A run with an artifact store persists its snapshot under a `snapshot` kind and records a `snapshotRef` on the report, so loading it re-checks the store digest, the id, and the signature. The evaluator child can be wrapped in a runtime the host names (`evaluation.sandboxCommand`/`sandboxArgs`): the child runs as `[...args, node, ...nodeArgs, entryPath]` with no shell, which is where CPU-time and network limits come from, because nothing in-process can express them. The plugin bundles no runtime and does not claim to enforce what it cannot see, so a resource/network/filesystem sandbox for untrusted candidate code is still the host's to install. Reversible tool lifecycle cleanup is covered, and the profile/patch contract is verified and implemented. Stronger sandboxing and a real simulator adapter remain future work.
