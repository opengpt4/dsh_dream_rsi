# Decisions needed

6 items in `TODO.md` are marked `[!]`: they cannot be settled from inside this
repository because they choose a provider, a runtime, a benchmark, or a person.
Of the 17 open items, 14 wait on one of these six; the remaining 3 are in-tree
work (§8). Sections whose decision has been made are kept as the record of what
was chosen.

Each section states what already exists, the decision, the options with the
tradeoff that matters here, and the smallest answer that lets work start.
Nothing in this document is a recommendation unless it says so.

Every item is referenced by its leading text in a backticked `TODO:` span,
which `test/documentation.test.mjs` resolves against `TODO.md`. A reference that
names no open item, or an open item that no section names, fails the suite.

---

## 1. Signing scheme — decided

**Decided:** Ed25519 detached signatures over the record id, with public keys in
an SPKI PEM key ring carrying per-key validity windows. Implemented in
`src/registry/signing.ts`; the scheme is described in `DETAILED_DESIGN_SPEC`
§9.1.2.

**What the decision settled.** `SignatureVerifier.verify` returns a verdict with
its reason instead of a boolean, so "expired key" and "tampered artifact" reach
the operator through the deployment refusal rather than as one flat rejection.
Rotation is a `notBefore`/`notAfter` bound per ring entry: a new key signs while
signatures from the old one still verify, and retiring a key closes a bound
instead of deleting the key behind the audit trail. `signPolicyArtifact` refuses
a body that does not hash to its id, and the verifier recomputes that hash before
checking the signature, so a swapped body cannot ride a signature made for the
id it now claims.

**What remains, and why it is not a decision.** Applying the same scheme to
evaluation reports and snapshots needs no answer from anyone; it is in §8.

---

## 2. Container or OS-level sandbox

**Claims** `TODO: Select and implement container or OS-level sandbox`, release
blocker `TODO: Strong OS/container isolation for untrusted candidate code`, and
the remaining CPU and network limits of
`TODO: Add CPU, memory, process-count, wall-time, filesystem, and network limits`
and `TODO: AST, dependency, resource, and network guards`.

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

## 3. First simulator and task family

**Claims** `TODO: Select first simulator and task family`, and with it
`TODO: Add deterministic seed and large-payload artifact capture`,
`TODO: Compare fixed baseline, hand-designed policy, evolved policy, and holdout performance`,
`TODO: Holdout gate with sufficient samples and per-task-family report`, and
`TODO: Multi-task benchmark evidence`.

**Already built.** The `EnvironmentAdapter` boundary is enforced: the SDK is
reached only through `embodied/mock-adapter.ts`, the protocol depends on nothing
but the core data model, and `test/architecture.test.mjs` fails if that changes.
`observe`, `availableActions`, `execute`, `emergencyStop`, `reset`,
`releaseAllSessions`, and `capability()` are the whole surface.

**The decision.** Which benchmark, and with it: whether a Python simulator needs
a bridge (every manipulation benchmark of note — Meta-World, ManiSkill,
RoboSuite, PyBullet — is Python, so the adapter would proxy across processes),
whether the host will install it, and whether it can supply the two topological
families that `TODO: Define at least two task families with distinct search-space topology`
needs and the randomness and payloads the seed item needs.

**Criteria that matter here, in order:** (1) two task families with distinct
search-space topology; (2) a deterministic seed and large sensor payloads;
(3) installable in this environment; (4) a coordinate frame and scoring function
stable enough to freeze for
`TODO: Freeze observation schema, coordinate system, action capability profile, and scoring function`.

**Smallest answer needed:** a name. If the choice is delegated to me, say so and
I will pick against those four criteria and document the reasoning.

---

## 4. Freeze the observation schema, frame, capability profile, and scoring

**Claims** `TODO: Freeze observation schema, coordinate system, action capability profile, and scoring function`.

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
really a question about §3, since a real simulator will want a frame and
sensors the mock does not have.

**Smallest answer needed:** "freeze the current values as v1" (then a simulator
adapter conforms to them), or "freeze after the simulator is chosen".

---

## 5. Two task families with distinct search-space topology

**Claims** `TODO: Define at least two task families with distinct search-space topology`
and `TODO: Test cross-task transfer and quantify transfer degradation`.

**Already built.** Tasks carry `taskId`, `goal`, `environmentId`, `budget`, and
metadata; `CaseResult` carries `taskFamily`; the split assigns by `taskId` and is
deterministic, and the holdout gate already refuses a case whose family differs
between two reports.

**The decision.** Which two topologies. The distinction the design cares about is
depth against branching — for example a sequential navigation family, where the
search is a path, against an ordering family, where it is a permutation with
irreversible steps. Both must be real tasks in the chosen simulator.

**Smallest answer needed:** the two families' shapes, or delegate and I will
propose them once §3 is answered.

---

## 6. Real `EnvironmentAdapter`

**Claims** `TODO: Implement one real EnvironmentAdapter`.

**Blocked on §3.** No decision of its own; it is the implementation of that
answer against the boundary in §3. The adapter must satisfy the schema freeze in
§4 and produce the randomness and payloads the seed item in §3 needs.

---

## 7. Human safety owner

**Claims** `TODO: Review high-risk embodied actions with a human safety owner`.

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

## 8. Open items that do not wait on these

- `TODO: Extend the dream status facade to the rest of the FUNCTIONAL_SPEC.md §4.4 report`
  — current policy, latest evaluation, and resource usage, none of which waits on
  a decision.
- `TODO: Extend signing to evaluation reports and snapshots` — the scheme is
  chosen (§1); applying it to two more record ids is the remaining work.
- `TODO: Immutable signed policy/evaluation/snapshot artifacts` — the release
  blocker whose scheme is decided in §1; only the item above closes it.

---

## What each answer unblocks

| Answer | Unblocks |
|---|---|
| Simulator (§3) | the simulator, adapter, seed, holdout-evidence, and benchmark items — the largest single block, and the only route to real holdout evidence |
| Schema freeze (§4) | the freeze item, and the comparability of every score after it |
| Signing (§1) — answered | kept as the record; the remaining report and snapshot signing is in §8 |
| Sandbox (§2) | the sandbox item, the remaining CPU and network limits, and the OS/container release blocker |
| Task families (§5) | the two-family and cross-task-transfer items |
| Safety owner (§7) | the human-review item |

Until these are answered, the work available is hardening what exists. That has
found real defects — a fabricated emergency stop, a trusted tampered deployment
record, a holdout-gate bypass, an unchecked artifact identity — but they have
become steadily smaller and more recently have been in tests and documentation
rather than in shipped logic, which is the honest measure of how much is left on
that side.
