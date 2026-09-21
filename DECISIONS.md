# Decisions needed

Seven items in `TODO.md` are marked `[!]`: they cannot be settled from inside
this repository because they choose a provider, a runtime, a benchmark, or a
person. Everything reachable without them has been done, and the remaining
seventeen open items sit behind these seven.

Each section states what already exists, the decision, the options with the
tradeoff that matters here, and the smallest answer that lets work start.
Nothing in this document is a recommendation unless it says so.

---

## 1. Signing scheme (item 84, release blocker 189)

**Already built.** `SignatureVerifier` is a seam: `verify(artifact): boolean`,
injected into `DeploymentWriter`. The deployment path refuses an unsigned
artifact when no verifier is wired, refuses a verifier that returns false, and
refuses one that throws — all three mutation-checked. A `sourceSha256` binds the
policy source, and `sourceRef` locations are verified separately.

**Missing.** A scheme, a key ring, and rotation. `signedArtifact` is claimed in
`DETAILED_DESIGN_SPEC` 8.2 and is not implemented.

**Options.**

| Option | What the repository would do | Cost |
|---|---|---|
| Ed25519 detached signature over the artifact body, public keys in a PEM key ring | Implement the verifier in-tree with `node:crypto`, plus rotation and failure tests | No new dependency; the only option whose rotation is testable here |
| KMS/HSM-backed verifier (AWS, GCP, Vault) | Ship only the interface; the host supplies the verifier | Nothing to test locally beyond the failures already covered |
| Keyless (sigstore/cosign, OIDC identity) | Ship only the interface | Needs network at verification time, which the evaluator child is denied |

**The tradeoff.** Rotation is the part that needs a decision, not signing.
A key ring with a validity window is testable in this repository; a KMS is not.
The first option is the only one that closes the blocker with in-tree evidence.

**Smallest answer needed:** `Ed25519 with a PEM key ring`, or `KMS — implement
only the interface`, or `keyless`.

---

## 2. Container or OS-level sandbox (item 92, release blocker 188)

**Already built.** Every isolated child runs under Node's permission model: a
read grant scoped to its own directory, no write, no `child_process`, no worker
threads, `PATH`-only environment, bounded output, a V8 heap ceiling (512 MiB),
a deadline, and a process-group kill. A probe confirmed the model does **not**
restrict network, and Node exposes no CPU-time ceiling — so CPU and network are
the two limits that genuinely need this decision.

**Options.**

| Option | Gives | Cost |
|---|---|---|
| OCI container per evaluation (`docker`/`podman` run: no network, read-only rootfs, cpu/memory/pids limits) | CPU, memory, network, filesystem | Requires a container runtime on the host, and the evaluator becomes a container launch |
| OS-native (Linux `bwrap`/namespaces/seccomp; macOS `sandbox-exec`) | Same, without a runtime | Platform-specific; `sandbox-exec` is undocumented and deprecated |
| In-process isolation for candidate code only (SES/isolate-vm) | Excludes native escapes | Restricts the policy language; does not confine a child process |

**The tradeoff.** A container makes the evaluator depend on a runtime being
present; in-process isolation avoids that but narrows what a policy may be. The
repository can implement any of them behind the existing `runIsolatedChild`
seam, so the decision is which dependency the host must have.

**Smallest answer needed:** name the runtime the host will provide, or say
"in-process, policy language restricted".

---

## 3. First simulator and task family (item 149)

**Already built.** The `EnvironmentAdapter` boundary is enforced: the SDK is
reached only through `embodied/mock-adapter.ts`, the protocol depends on nothing
but the core data model, and `test/architecture.test.mjs` fails if that changes.
`observe`, `availableActions`, `execute`, `emergencyStop`, `reset`,
`releaseAllSessions`, and `capability()` are the whole surface.

**The decision.** Which benchmark, and with it: whether a Python simulator needs
a bridge (every manipulation benchmark of note — Meta-World, ManiSkill,
RoboSuite, PyBullet — is Python, so the adapter would proxy across processes),
whether the host will install it, and whether it can supply the two topological
families item 159 needs and the randomness/payloads item 152 needs.

**Criteria that matter here, in order:** (1) two task families with distinct
search-space topology; (2) a deterministic seed and large sensor payloads;
(3) installable in this environment; (4) a coordinate frame and scoring function
stable enough to freeze for item 150.

**Smallest answer needed:** a name. If the choice is delegated to me, say so and
I will pick against those four criteria and document the reasoning.

---

## 4. Freeze the observation schema, frame, capability profile, and scoring (item 150)

**Already built.** All four exist and are versioned or injectable:
`OBSERVATION_SCHEMA_VERSION` with `assertObservationSchema` on every recorded
observation; `frameId` reported on every observation; `MOCK_CAPABILITY_PROFILE`
with `profileId`, sensors, frames, per-action `risk`, `requiresConfirmation` and
limits; `EvaluatorConfig` and `HoldoutGateConfig` for scoring.

**What "freeze" means mechanically.** Declare the current values as the v1
contract and add a test that fails when any of them changes, so a change is a
version bump rather than an edit. That is small, and it is the thing that makes
every later score comparable.

**The decision** is whether the current values are the ones to freeze — which is
really a question about item 3, since a real simulator will want a frame and
sensors the mock does not have.

**Smallest answer needed:** "freeze the current values as v1" (then a simulator
adapter conforms to them), or "freeze after the simulator is chosen".

---

## 5. Two task families with distinct search-space topology (item 159)

**Already built.** Tasks carry `taskId`, `goal`, `environmentId`, `budget`, and
metadata; `CaseResult` carries `taskFamily`; the split assigns by `taskId` and is
deterministic, and the holdout gate already refuses a case whose family differs
between two reports.

**The decision.** Which two topologies. The distinction the design cares about is
depth against branching — for example a sequential navigation family, where the
search is a path, against an ordering family, where it is a permutation with
irreversible steps. Both must be real tasks in the chosen simulator.

**Smallest answer needed:** the two families' shapes, or delegate and I will
propose them once item 3 is answered.

---

## 6. Real `EnvironmentAdapter` (item 151)

**Blocked on item 3.** No decision of its own; it is the implementation of that
answer against the boundary in §3. The adapter must satisfy the schema
freeze in §4 and produce the randomness and payloads item 152 needs.

---

## 7. Human safety owner (item 179)

**Already built.** Every action's `risk` and `requiresConfirmation` are declared
in the capability profile, and confirmation is denied unless the host supplies a
hook — approval is opt-in and never implied.

**The decision.** A named person, and what they are signing off. The review can
be bounded to the profile's action table: for each action, its risk level, its
parameter limits, and whether it requires confirmation; plus the emergency-stop
and lease behaviour. That is a page, not a project.

**Smallest answer needed:** a name, and whether the review covers the mock
profile now or waits for the real adapter.

---

## What each answer unblocks

| Answer | Unblocks |
|---|---|
| Simulator (§3) | items 149, 151, 152, 160, 163, 191, 195 — the largest single block, and the only route to real holdout evidence |
| Schema freeze (§4) | item 150, and the comparability of every score after it |
| Signing (§1) | item 84 and release blocker 189 |
| Sandbox (§2) | item 92, item 91's remaining CPU and network limits, and release blocker 188 |
| Task families (§5) | items 159, 160, 163 |
| Safety owner (§7) | item 179 |

Until these are answered, the work available is hardening what exists. That has
found real defects — a fabricated emergency stop, a trusted tampered deployment
record, a holdout-gate bypass, an unchecked artifact identity — but they have
become steadily smaller and more recently have been in tests and documentation
rather than in shipped logic, which is the honest measure of how much is left on
that side.
