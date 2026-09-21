# Production Approval Policy

What this project does by default, and what an operator must do explicitly.

The safety defaults are stated once, as JSON, so they can be checked against the
running configuration rather than drifting from it. `test/governance.test.mjs`
parses this block and compares it with `resolveDreamRsiConfig({})`.

```json
{
  "evolution.enabled": false,
  "evolution.autoDeploy": false,
  "embodied.enabled": false,
  "embodied.requireConfirmation": true,
  "evaluation.minimumHoldoutSamples": 20,
  "replay.missRateMax": 0.05
}
```

## Automatic deployment is off

Deployment requires a registered policy artifact, a passing holdout gate
covering the exact evaluation being deployed, an explicit operator approval,
and a passing canary. Nothing on that path deploys itself.

`evolution.autoDeploy` is not consumed by anything, so it stays `false` while any
release blocker in `TODO.md` remains open: implementing it is a deliberate act,
not a configuration change. `test/candidate-generation.test.mjs` asserts the
guarantee directly by running the whole generation path with the flag on and a
passing gate, and checking the current-policy pointer has not moved.

## Configuration fields nothing consumes

These are accepted by the schema, validated, and reported by `dream_status` where
they appear there, and read by no code path. Each is a declaration of intent
rather than a switch. `test/architecture.test.mjs` derives the set from the
source and requires it to match this list, so wiring one is a deliberate change
that updates this section in the same commit, and a new field nothing reads has
to be documented here rather than left to imply a capability.

- `runtime.maxWorkers` — no worker pool exists; the isolated evaluator runs one child per evaluation.
- `runtime.taskTimeoutMs` — an episode is bounded by `Task.budget.wallClockMs` and each action by its own timeout, so there is no configuration-level task ceiling.
- `evolution.maxCandidates` — there is no candidate loop; `generateCandidate` produces one proposal per call.
- `evolution.autoDeploy` — nothing promotes a policy on its own; promotion requires an explicit approval, a passing gate verdict covering the evaluation, and a passing canary.
- `storage.artifactDir` — the runtime builds no artifact store and `src/` constructs no `FileArtifactStore`, so this is the location a host passes to `createPolicyArtifactWithSource` rather than one the plugin opens.

## Approval is never implied

`PolicyRegistry.promotePolicy` refuses a deployment without an `Approval` whose
`decision` is `approved` and which carries an operator identity. The deployment
writer additionally refuses an approval recorded under another principal's name,
and checks every governed transition against the access policy.

| Governed action | Default roles |
|---|---|
| `evolve` | operator, admin |
| `approve` | approver, admin |
| `deploy` | approver, admin |
| `rollback` | operator, approver, admin |
| `approve-tool` | approver, admin |
| `emergency-stop` | operator, approver, admin |

`approve` and `deploy` are separate grants, so the principal that proposes a
candidate is not automatically the principal that may put it live. `admin` is
the break-glass role.

## High-risk actions require confirmation

A capability whose `requiresConfirmation` is set is denied unless the host
supplies a confirmation provider. The runtime configures none by default, so a
high-risk action fails closed rather than being admitted because nobody wired
the check.

## Evaluator isolation is required

Evaluation runs in a child process that leads its own process group, with a
deadline, bounded output, and a `PATH`-only environment. Approval is still
required before deployment.

## Retention

Artifacts carry retention at write time. Policy, tool, and evaluation artifacts
are retained indefinitely because they are the audit trail. Observation
artifacts default to seven days, sandbox output to one day, and LLM responses to
thirty. `pruneExpired` only runs when an operator calls it: unattended deletion
is an audit-trail hazard.

## Recovery from a stopped session

An emergency stop latches the session and is audited. It is never retried
automatically; re-arming a stopped session requires an explicit
`releaseSession`.
