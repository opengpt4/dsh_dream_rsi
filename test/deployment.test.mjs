import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DeploymentWriter,
  Ed25519SignatureVerifier,
  FileAuditLog,
  InMemoryAuditLog,
  InMemoryPolicyRegistryStore,
  PolicyRegistry,
  SingleWriterLock,
  canTransitionDeployment,
  createEvaluationReport,
  createPolicyArtifact,
  signPolicyArtifact,
  transitionDeployment,
  verifyAuditEvent,
  verifyDeployment
} from '../dist/index.js';

const AT = '2026-01-01T00:00:00.000Z';
const CONFIG_HASH = 'c'.repeat(64);

const THRESHOLDS = {
  minQuality: 0.5,
  maxErrorRate: 0.1,
  maxLatencyMs: 1_000,
  maxCost: 1,
  maxMissRate: 0.05
};

const HEALTHY = { quality: 1, errorRate: 0, latencyMs: 10, cost: 0.1, missRate: 0 };
const BREACHING = { quality: 0.1, errorRate: 0.9, latencyMs: 5_000, cost: 9, missRate: 0.9 };

const APPROVAL = { approvalId: 'approval-1', operator: 'operator-1', decision: 'approved', decidedAt: AT };

function policy(version, overrides = {}) {
  return createPolicyArtifact({
    version,
    parentVersion: version === 'v1' ? null : 'v1',
    source: `export const decide = () => ${version.length};`,
    manifest: { entrypoint: 'src/policy.ts', dependencies: [], schemaVersion: 1 },
    allowedCapabilities: ['scheduling'],
    createdBy: 'human',
    createdAt: AT,
    ...overrides
  });
}

function report(artifactId, overrides = {}) {
  return createEvaluationReport({
    evaluatorVersion: '0.1.0',
    sourceHash: 'a'.repeat(64),
    snapshotId: 'b'.repeat(64),
    policyArtifactId: artifactId,
    split: 'holdout',
    configHash: CONFIG_HASH,
    metrics: { quality: 1, cost: 0.1, parallelEfficiency: 1, missRate: 0, score: 1 },
    caseResults: [{ caseId: 'case-1', taskFamily: 'packing', split: 'holdout', outcome: 'passed', quality: 1, score: 1 }],
    sampleCount: 1,
    passed: true,
    guardResults: [],
    createdAt: AT,
    ...overrides
  });
}

/** A registry holding one passing artifact, ready to be proposed. */
function setup({ signatureVerifier = { verify: () => ({ valid: true }) }, registry = undefined, signWith = undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-deploy-'));
  const audit = new InMemoryAuditLog();
  const owner = registry ?? new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const unsigned = policy('v1');
  const artifact = signWith === undefined ? unsigned : signPolicyArtifact(unsigned, signWith);
  owner.registerPolicy(artifact);
  const evaluation = report(artifact.artifactId);
  owner.registerEvaluation(evaluation);

  // Distinct timestamps per call, so deployment ordering is deterministic
  // instead of depending on how fast the test runs.
  let tick = Date.parse(AT);
  const lock = new SingleWriterLock(join(dir, 'deployment.lock'), 30_000);
  const writer = new DeploymentWriter({
    registry: owner,
    lock,
    audit,
    principal: { principalId: 'operator-1', roles: ['admin'] },
    now: () => new Date((tick += 1_000)),
    // `null` means "deliberately unconfigured"; an explicit `undefined` would
    // trip the default parameter instead.
    ...(signatureVerifier === null ? {} : { signatureVerifier })
  });

  const gate = { passed: true, candidateEvaluationId: evaluation.evaluationId };
  return {
    dir,
    audit,
    registry: owner,
    lock,
    writer,
    lockPath: join(dir, 'deployment.lock'),
    artifact,
    evaluation,
    gate,
    propose: () => writer.propose({ policyArtifactId: artifact.artifactId, evaluationId: evaluation.evaluationId, holdoutGate: gate }),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

// -------------------------------------------------------------- state machine

test('the deployment state machine follows the spec transitions exactly', () => {
  assert.equal(canTransitionDeployment('PROPOSED', 'APPROVED'), true);
  assert.equal(canTransitionDeployment('PROPOSED', 'REJECTED'), true);
  assert.equal(canTransitionDeployment('APPROVED', 'CANARY'), true);
  assert.equal(canTransitionDeployment('APPROVED', 'ROLLED_BACK'), true);
  assert.equal(canTransitionDeployment('CANARY', 'ACTIVE'), true);
  assert.equal(canTransitionDeployment('CANARY', 'ROLLED_BACK'), true);
  assert.equal(canTransitionDeployment('ACTIVE', 'DEGRADED'), true);
  assert.equal(canTransitionDeployment('DEGRADED', 'ROLLED_BACK'), true);

  // An active deployment degrades first, so a rollback records that degradation
  // was observed rather than jumping to the end state.
  assert.equal(canTransitionDeployment('ACTIVE', 'ROLLED_BACK'), false);
  assert.equal(canTransitionDeployment('PROPOSED', 'ACTIVE'), false);
  assert.equal(canTransitionDeployment('PROPOSED', 'CANARY'), false);

  for (const terminal of ['REJECTED', 'ROLLED_BACK']) {
    for (const next of ['PROPOSED', 'APPROVED', 'CANARY', 'ACTIVE', 'DEGRADED']) {
      assert.equal(canTransitionDeployment(terminal, next), false, `${terminal} -> ${next}`);
    }
  }
  assert.throws(() => transitionDeployment('ACTIVE', 'ROLLED_BACK'), /illegal deployment transition/);
});

// ---------------------------------------------------------------- happy path

test('a deployment moves PROPOSED -> APPROVED -> CANARY -> ACTIVE and moves the pointer', () => {
  const context = setup();
  try {
    const proposed = context.propose();
    assert.equal(proposed.state, 'PROPOSED');
    assert.deepEqual(proposed.history, ['PROPOSED']);
    assert.equal(proposed.rollbackTarget, null);
    assert.equal(context.registry.currentPolicyArtifactId(), null, 'proposing is not deploying');

    const approved = context.writer.decide(proposed.deploymentId, APPROVAL);
    assert.equal(approved.state, 'APPROVED');

    const canary = context.writer.startCanary(proposed.deploymentId);
    assert.equal(canary.state, 'CANARY');
    assert.equal(context.registry.currentPolicyArtifactId(), null);

    const active = context.writer.completeCanary(proposed.deploymentId, HEALTHY, THRESHOLDS);
    assert.equal(active.state, 'ACTIVE');
    assert.deepEqual(active.history, ['PROPOSED', 'APPROVED', 'CANARY', 'ACTIVE']);
    assert.equal(context.registry.currentPolicyArtifactId(), context.artifact.artifactId);
    assert.equal(active.canary.passed, true);
    assert.equal(active.lockOwner, context.lock.owner);

    assert.deepEqual(context.audit.types(), [
      'policy.proposed',
      'policy.approved',
      'canary.started',
      'policy.deployed'
    ]);
  } finally {
    context.cleanup();
  }
});

test('a second writer instance can activate what the first proposed', () => {
  // Activation restamps `lockOwner`, which is part of the hashed body. A writer
  // other than the one that proposed holds a different owner, so the record has
  // to be resealed rather than edited, or it stops matching its own hash.
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-deploy-'));
  try {
    const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
    const artifact = policy('v1');
    registry.registerPolicy(artifact);
    const evaluation = report(artifact.artifactId);
    registry.registerEvaluation(evaluation);
    const proposerLock = new SingleWriterLock(join(dir, 'deployment.lock'), 30_000);
    const activatorLock = new SingleWriterLock(join(dir, 'deployment.lock'), 30_000);
    assert.notEqual(proposerLock.owner, activatorLock.owner);

    const makeWriter = (lock) => new DeploymentWriter({
      registry,
      lock,
      audit: new InMemoryAuditLog(),
      principal: { principalId: 'operator-1', roles: ['admin'] },
      signatureVerifier: { verify: () => ({ valid: true }) }
    });
    const proposer = makeWriter(proposerLock);
    const proposed = proposer.propose({
      policyArtifactId: artifact.artifactId,
      evaluationId: evaluation.evaluationId,
      holdoutGate: { passed: true, candidateEvaluationId: evaluation.evaluationId }
    });
    // The proposing writer stamps its own owner through approve and canary, so
    // the activating writer is the only one that changes it — which is what
    // makes the activation edit need a reseal rather than a spread.
    proposer.decide(proposed.deploymentId, APPROVAL);
    proposer.startCanary(proposed.deploymentId);
    const active = makeWriter(activatorLock).completeCanary(proposed.deploymentId, HEALTHY, THRESHOLDS);

    assert.equal(active.state, 'ACTIVE');
    assert.equal(active.lockOwner, activatorLock.owner);
    assert.equal(verifyDeployment(active), true);
    assert.equal(verifyDeployment(registry.latestDeployment()), true);
    assert.equal(registry.currentPolicyArtifactId(), artifact.artifactId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rejected proposal never reaches the canary and leaves the pointer alone', () => {
  const context = setup();
  try {
    const proposed = context.propose();
    const rejected = context.writer.decide(proposed.deploymentId, { ...APPROVAL, decision: 'rejected', reason: 'unsafe' });

    assert.equal(rejected.state, 'REJECTED');
    assert.deepEqual(rejected.history, ['PROPOSED', 'REJECTED']);
    assert.equal(context.registry.currentPolicyArtifactId(), null);
    assert.throws(() => context.writer.startCanary(proposed.deploymentId), /illegal deployment transition/);
    assert.deepEqual(context.audit.types(), ['policy.proposed', 'policy.rejected']);
  } finally {
    context.cleanup();
  }
});

test('an illegal transition is refused rather than inferred', () => {
  const context = setup();
  try {
    const proposed = context.propose();
    assert.throws(() => context.writer.startCanary(proposed.deploymentId), /illegal deployment transition PROPOSED -> CANARY/);
    assert.equal(context.registry.currentPolicyArtifactId(), null);
  } finally {
    context.cleanup();
  }
});

// ------------------------------------------------------------ canary checks

test('a canary that breaches a threshold rolls the deployment back', () => {
  const context = setup();
  try {
    const proposed = context.propose();
    context.writer.decide(proposed.deploymentId, APPROVAL);
    context.writer.startCanary(proposed.deploymentId);

    const rolledBack = context.writer.completeCanary(proposed.deploymentId, BREACHING, THRESHOLDS);

    assert.equal(rolledBack.state, 'ROLLED_BACK');
    assert.equal(rolledBack.canary.passed, false);
    assert.deepEqual(rolledBack.canary.failures, ['quality', 'errorRate', 'latencyMs', 'cost', 'missRate']);
    assert.match(rolledBack.reason, /canary thresholds breached/);
    assert.equal(context.registry.currentPolicyArtifactId(), null);
    assert.deepEqual(context.audit.types(), ['policy.proposed', 'policy.approved', 'canary.started', 'canary.failed']);
  } finally {
    context.cleanup();
  }
});

test('activation is refused when the baseline moved after the proposal', () => {
  const context = setup();
  try {
    const proposed = context.propose();
    context.writer.decide(proposed.deploymentId, APPROVAL);
    context.writer.startCanary(proposed.deploymentId);

    // Someone else deployed a different policy in the meantime.
    const intruder = policy('v-intruder');
    context.registry.registerPolicy(intruder);
    context.registry.registerEvaluation(report(intruder.artifactId));
    const intruderEvaluation = context.registry.evaluationsFor(intruder.artifactId)[0];
    context.registry.promotePolicy(intruder.artifactId, {
      evaluationId: intruderEvaluation.evaluationId,
      holdoutGate: { passed: true, candidateEvaluationId: intruderEvaluation.evaluationId },
      approval: APPROVAL,
      canary: { passed: true, observation: HEALTHY, thresholds: THRESHOLDS, failures: [], observedAt: AT }
    });

    assert.throws(
      () => context.writer.completeCanary(proposed.deploymentId, HEALTHY, THRESHOLDS),
      /baseline moved since this deployment was proposed/
    );
    assert.equal(context.registry.currentPolicyArtifactId(), intruder.artifactId, 'the intruder is untouched');
  } finally {
    context.cleanup();
  }
});

// --------------------------------------------------------- artifact checks

test('deployment refuses to proceed without a signature verifier', () => {
  const context = setup({ signatureVerifier: null });
  try {
    const proposed = context.propose();
    context.writer.decide(proposed.deploymentId, APPROVAL);

    // Fail closed: an unsigned artifact must not reach production because nobody
    // wired the check.
    assert.throws(() => context.writer.startCanary(proposed.deploymentId), /no signature verifier is configured/);
    assert.equal(context.registry.currentPolicyArtifactId(), null);
  } finally {
    context.cleanup();
  }
});

test('deployment refuses an artifact whose signature does not verify', () => {
  const context = setup({ signatureVerifier: { verify: () => ({ valid: false, reason: 'the key is not trusted' }) } });
  try {
    const proposed = context.propose();
    context.writer.decide(proposed.deploymentId, APPROVAL);

    assert.throws(() => context.writer.startCanary(proposed.deploymentId), /failed signature verification/);
    assert.equal(context.registry.currentPolicyArtifactId(), null);
  } finally {
    context.cleanup();
  }
});

test('the deployment refusal carries the signature reason', () => {
  // "Expired key" and "tampered artifact" call for different operator action,
  // and the error is where that gets read.
  const context = setup({
    signatureVerifier: { verify: () => ({ valid: false, reason: 'key rotate-2026 expired at 2026-06-30' }) }
  });
  try {
    const proposed = context.propose();
    context.writer.decide(proposed.deploymentId, APPROVAL);

    assert.throws(
      () => context.writer.startCanary(proposed.deploymentId),
      /failed signature verification: key rotate-2026 expired at 2026-06-30/
    );
  } finally {
    context.cleanup();
  }
});

test('an unsigned artifact is refused by the Ed25519 verifier', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  void privateKey;
  const context = setup({
    signatureVerifier: new Ed25519SignatureVerifier({ keys: [{ keyId: 'rotate-2026', publicKeyPem }] })
  });
  try {
    const proposed = context.propose();
    context.writer.decide(proposed.deploymentId, APPROVAL);

    assert.throws(() => context.writer.startCanary(proposed.deploymentId), /failed signature verification: it is unsigned/);
    assert.equal(context.registry.currentPolicyArtifactId(), null);
  } finally {
    context.cleanup();
  }
});

test('a signed artifact activates through the Ed25519 verifier', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const context = setup({
    signWith: {
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      keyId: 'rotate-2026'
    },
    signatureVerifier: new Ed25519SignatureVerifier({
      keys: [{ keyId: 'rotate-2026', publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() }]
    })
  });
  try {
    const proposed = context.propose();
    context.writer.decide(proposed.deploymentId, APPROVAL);
    context.writer.startCanary(proposed.deploymentId);
    const active = context.writer.completeCanary(proposed.deploymentId, HEALTHY, THRESHOLDS);

    assert.equal(active.state, 'ACTIVE');
    assert.equal(verifyDeployment(active), true);
    assert.equal(context.registry.currentPolicyArtifactId(), context.artifact.artifactId);
    // The signature is not part of the id, so the pointer names the same
    // artifact the registry held before signing.
    assert.equal(context.artifact.signature.keyId, 'rotate-2026');
  } finally {
    context.cleanup();
  }
});

test('a verifier that throws is a refusal, not a bypass', () => {
  // A provider that cannot reach its key service throws rather than returning
  // false. That has to refuse the deployment: catching the error and trusting
  // the artifact is the one failure mode this check exists to prevent, and
  // nothing pinned it.
  const context = setup({
    signatureVerifier: {
      verify: () => {
        throw new Error('key service unreachable');
      }
    }
  });
  try {
    const proposed = context.propose();
    context.writer.decide(proposed.deploymentId, APPROVAL);

    assert.throws(() => context.writer.startCanary(proposed.deploymentId), /key service unreachable/);
    assert.equal(context.registry.currentPolicyArtifactId(), null);
    assert.equal(context.registry.latestDeployment().state, 'APPROVED');
    // The failure is not a transition, so the trail claims none.
    assert.deepEqual(context.audit.types(), ['policy.proposed', 'policy.approved']);
  } finally {
    context.cleanup();
  }
});

test('deployment refuses an artifact whose checksum does not match its id', () => {
  const context = setup();
  try {
    const proposed = context.propose();
    context.writer.decide(proposed.deploymentId, APPROVAL);

    // Mutate the stored record after registration, which is the attack the
    // checksum exists to catch: the id no longer matches the body.
    const stored = context.registry.policy(context.artifact.artifactId);
    stored.allowedCapabilities.push('everything');

    assert.throws(() => context.writer.startCanary(proposed.deploymentId), /failed its checksum/);
    assert.equal(context.registry.currentPolicyArtifactId(), null);
  } finally {
    context.cleanup();
  }
});

// ----------------------------------------------------------------- rollback

test('rolling back an active deployment degrades first and restores the previous version', () => {
  const context = setup();
  try {
    const first = context.propose();
    context.writer.decide(first.deploymentId, APPROVAL);
    context.writer.startCanary(first.deploymentId);
    context.writer.completeCanary(first.deploymentId, HEALTHY, THRESHOLDS);
    assert.equal(context.registry.currentPolicyArtifactId(), context.artifact.artifactId);

    const secondPolicy = policy('v2');
    context.registry.registerPolicy(secondPolicy);
    const secondEvaluation = report(secondPolicy.artifactId);
    context.registry.registerEvaluation(secondEvaluation);
    const second = context.writer.propose({
      policyArtifactId: secondPolicy.artifactId,
      evaluationId: secondEvaluation.evaluationId,
      holdoutGate: { passed: true, candidateEvaluationId: secondEvaluation.evaluationId }
    });
    assert.equal(second.rollbackTarget, context.artifact.artifactId, 'the baseline is what is live now');

    context.writer.decide(second.deploymentId, APPROVAL);
    context.writer.startCanary(second.deploymentId);
    context.writer.completeCanary(second.deploymentId, HEALTHY, THRESHOLDS);
    assert.equal(context.registry.currentPolicyArtifactId(), secondPolicy.artifactId);

    const rolledBack = context.writer.rollback(second.deploymentId, { operator: 'operator-1', reason: 'quality dropped' });

    assert.equal(rolledBack.state, 'ROLLED_BACK');
    // Degradation is recorded, not skipped.
    assert.deepEqual(rolledBack.history, ['PROPOSED', 'APPROVED', 'CANARY', 'ACTIVE', 'DEGRADED', 'ROLLED_BACK']);
    assert.equal(context.registry.currentPolicyArtifactId(), context.artifact.artifactId);
    assert.ok(context.audit.types().includes('policy.degraded'));
    assert.ok(context.audit.types().includes('policy.rolled-back'));
  } finally {
    context.cleanup();
  }
});

test('at least three stable versions are retained for rollback', () => {
  const context = setup();
  try {
    const activated = [];
    for (const version of ['v1', 'v2', 'v3']) {
      const artifact = version === 'v1' ? context.artifact : policy(version);
      if (version !== 'v1') {
        context.registry.registerPolicy(artifact);
        context.registry.registerEvaluation(report(artifact.artifactId));
      }
      const evaluation = context.registry.evaluationsFor(artifact.artifactId)[0];
      const proposed = context.writer.propose({
        policyArtifactId: artifact.artifactId,
        evaluationId: evaluation.evaluationId,
        holdoutGate: { passed: true, candidateEvaluationId: evaluation.evaluationId }
      });
      context.writer.decide(proposed.deploymentId, APPROVAL);
      context.writer.startCanary(proposed.deploymentId);
      context.writer.completeCanary(proposed.deploymentId, HEALTHY, THRESHOLDS);
      activated.push(artifact.artifactId);
    }

    const stable = context.registry.stableVersions(3);
    assert.equal(stable.length, 3);
    assert.deepEqual([...stable].sort(), [...new Set(activated)].sort());
    assert.equal(context.registry.currentPolicyArtifactId(), activated[2]);

    // Rolling back the newest lands on the one before it.
    const latest = context.registry.listDeployments().at(-1);
    context.writer.rollback(latest.deploymentId, { operator: 'operator-1', reason: 'regression' });
    assert.equal(context.registry.currentPolicyArtifactId(), activated[1]);
  } finally {
    context.cleanup();
  }
});

// -------------------------------------------------------------------- audit

test('the audit trail records the writer, the operator, and the reason', () => {
  const context = setup();
  try {
    const proposed = context.propose();
    context.writer.decide(proposed.deploymentId, APPROVAL);
    context.writer.startCanary(proposed.deploymentId);
    context.writer.completeCanary(proposed.deploymentId, HEALTHY, THRESHOLDS);
    context.writer.markDegraded(proposed.deploymentId, 'latency spike');
    context.writer.rollback(proposed.deploymentId, { operator: 'operator-2', reason: 'rolled back after spike' });

    const events = context.audit.list();
    assert.deepEqual(events.map((event) => event.type), [
      'policy.proposed',
      'policy.approved',
      'canary.started',
      'policy.deployed',
      'policy.degraded',
      'policy.rolled-back'
    ]);
    for (const event of events) {
      assert.equal(event.policyArtifactId, context.artifact.artifactId);
      assert.equal(event.lockOwner, context.lock.owner);
      assert.match(event.eventId, /^[0-9a-f]{64}$/);
    }
    assert.equal(events[1].operator, 'operator-1');
    assert.equal(events[4].reason, 'latency spike');
    assert.equal(events[5].operator, 'operator-2');
    assert.equal(events[5].reason, 'rolled back after spike');
  } finally {
    context.cleanup();
  }
});

test('the file audit log appends one verifiable line per event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-audit-'));
  try {
    const log = new FileAuditLog(join(dir, 'audit.jsonl'));
    log.record({ type: 'policy.proposed', subject: 'deployment', subjectId: 'd1', policyArtifactId: 'p1', correlationId: 'c1', at: AT });
    log.record({ type: 'policy.approved', subject: 'deployment', subjectId: 'd1', policyArtifactId: 'p1', correlationId: 'c1', operator: 'op', at: AT });

    const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.type, 'policy.proposed');
    assert.equal(first.subject, 'deployment');
    assert.equal(first.subjectId, 'd1');
    assert.match(first.eventId, /^[0-9a-f]{64}$/);
    assert.equal(second.operator, 'op');

    // Read back through the log rather than by hand, so the lines are checked
    // against their ids rather than only looking like events.
    const events = log.read();
    assert.deepEqual(events.map((event) => event.type), ['policy.proposed', 'policy.approved']);
    assert.equal(verifyAuditEvent(events[0]), true);
    assert.equal(Object.isFrozen(events), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the file audit log refuses an altered or truncated line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-audit-'));
  const path = join(dir, 'audit.jsonl');
  try {
    const log = new FileAuditLog(path);
    const recorded = log.record({
      type: 'policy.rolled-back', subject: 'deployment', subjectId: 'd1',
      correlationId: 'c1', reason: 'operator rolled back', at: AT
    });

    // An edit to a covered field, with the stored id left alone.
    const altered = `${JSON.stringify({ ...recorded, reason: 'nothing happened' })}\n`;
    writeFileSync(path, altered);
    assert.throws(() => log.read(), /line 1 does not match its event id/);

    // A field the record never had is an alteration too, not invisible.
    writeFileSync(path, `${JSON.stringify({ ...recorded, note: 'extra' })}\n`);
    assert.throws(() => log.read(), /line 1 does not match its event id/);

    // An interrupted append: the writer is not atomic, so this must not be read
    // as an event.
    writeFileSync(path, `${JSON.stringify(recorded)}\n{"eventId":"ab`);
    assert.throws(() => log.read(), /line 2 is not a complete event/);

    // Truncation that removes the whole final line is a shorter trail, not a
    // corrupt one.
    writeFileSync(path, `${JSON.stringify(recorded)}\n`);
    assert.equal(log.read().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- writer lease

test('a second writer cannot interleave the state machine', () => {
  const context = setup();
  try {
    context.lock.acquire();
    assert.throws(() => context.propose(), /is already held/);
    context.lock.release();

    assert.equal(context.writer.propose({ policyArtifactId: context.artifact.artifactId, evaluationId: context.evaluation.evaluationId, holdoutGate: context.gate }).state, 'PROPOSED');
  } finally {
    context.cleanup();
  }
});

test('recovering an expired lease is audited', () => {
  const context = setup();
  try {
    // Simulate a crashed owner: the lock directory exists with an expired lease.
    mkdirSync(context.lockPath, { recursive: true });
    writeFileSync(join(context.lockPath, 'lease.json'), JSON.stringify({ ownerId: 'dead', expiresAt: Date.now() - 1_000 }));

    context.propose();

    assert.equal(context.lock.recoveredStaleLock, true);
    assert.equal(context.audit.types()[0], 'lock.recovered');
    assert.match(context.audit.list()[0].reason, /recovered an expired lease/);
  } finally {
    context.cleanup();
  }
});

// ---------------------------------------------------- stable version ordering

/** Promote one policy through the full state machine, returning its deployment. */
function activate(writer, registry, artifact) {
  registry.registerPolicy(artifact);
  const evaluation = report(artifact.artifactId);
  registry.registerEvaluation(evaluation);
  const proposed = writer.propose({
    policyArtifactId: artifact.artifactId,
    evaluationId: evaluation.evaluationId,
    holdoutGate: { passed: true, candidateEvaluationId: evaluation.evaluationId }
  });
  writer.decide(proposed.deploymentId, APPROVAL);
  writer.startCanary(proposed.deploymentId);
  return writer.completeCanary(proposed.deploymentId, HEALTHY, THRESHOLDS);
}

test('stable versions list the most recently activated first even on a tied clock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-stable-'));
  const audit = new InMemoryAuditLog();
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  // Every transition lands on the same millisecond, which is what a fast
  // automated sequence produces and what the previous ordering got backwards.
  const writer = new DeploymentWriter({
    registry,
    lock: new SingleWriterLock(join(dir, 'deployment.lock'), 30_000),
    audit,
    principal: { principalId: 'operator-1', roles: ['admin'] },
    signatureVerifier: { verify: () => ({ valid: true }) },
    now: () => new Date(AT)
  });

  try {
    const versions = ['v1', 'v2', 'v3'];
    for (const version of versions) activate(writer, registry, policy(version));

    const latestFirst = registry.stableVersions(3).map((id) => registry.policy(id).version);
    assert.deepEqual(latestFirst, ['v3', 'v2', 'v1']);

    // Retention keeps the newest, which is what "at least three stable versions"
    // is protecting: an inverted order would discard them.
    assert.deepEqual(registry.stableVersions(2).map((id) => registry.policy(id).version), ['v3', 'v2']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deployment degraded after activation does not jump the queue', () => {
  let clock = Date.parse(AT);
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-stable-'));
  const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
  const writer = new DeploymentWriter({
    registry,
    lock: new SingleWriterLock(join(dir, 'deployment.lock'), 30_000),
    audit: new InMemoryAuditLog(),
    principal: { principalId: 'operator-1', roles: ['admin'] },
    signatureVerifier: { verify: () => ({ valid: true }) },
    now: () => new Date((clock += 1_000))
  });

  try {
    const first = policy('v1');
    const firstDeployment = activate(writer, registry, first);
    const second = policy('v2');
    activate(writer, registry, second);

    // Degrading v1 updates its record long after v2 activated. Ordering by
    // `updatedAt` would put v1 first; ordering by activation does not.
    writer.markDegraded(firstDeployment.deploymentId, 'latency spike');

    assert.deepEqual(registry.stableVersions(3).map((id) => registry.policy(id).version), ['v2', 'v1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
