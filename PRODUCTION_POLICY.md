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

`evolution.autoDeploy` is a declaration rather than a switch: the schema accepts
it, the resolver requires `evolution.enabled` alongside it, and the status tool
reports it — and nothing reads it to do anything. Setting it today changes no
behaviour, which `test/candidate-generation.test.mjs` asserts by running the
whole generation path with it on and a passing gate, and
`test/architecture.test.mjs` enforces by failing if a third module names the
flag. That is why it stays `false` while any release blocker in `TODO.md`
remains open: implementing it is a deliberate act, not a configuration change.

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
