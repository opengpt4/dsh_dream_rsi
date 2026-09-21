import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_ACCESS_POLICY,
  DEFAULT_REDACTION_RULES,
  DEFAULT_RETENTION_POLICY,
  DeploymentWriter,
  FileArtifactStore,
  GOVERNED_ACTIONS,
  InMemoryAuditLog,
  InMemoryPolicyRegistryStore,
  PolicyRegistry,
  SingleWriterLock,
  assertAccess,
  checkAccess,
  createAuditEvent,
  createEvaluationReport,
  createPolicyArtifact,
  expiredArtifacts,
  putWithRetention,
  redactSecrets,
  redactValue,
  resolveDreamRsiConfig,
  retentionFor,
  validateRetentionPolicy,
  verifyAuditEvent
} from '../dist/index.js';

const AT = '2026-01-01T00:00:00.000Z';
const THRESHOLDS = { minQuality: 0.5, maxErrorRate: 0.1, maxLatencyMs: 1_000, maxCost: 1, maxMissRate: 0.05 };

// ------------------------------------------------------------------ redaction

test('known secret shapes are redacted and the rules that fired are reported', () => {
  const text = [
    'key=sk-abcdefghijklmnopqrstuvwxyz',
    'Authorization: Bearer abcdefghijklmnop.qrstuvwx',
    'DEEPSEEK_API_KEY=sk-live-0123456789abcdef',
    'postgres://user:hunter2@db.internal:5432/app',
    'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP'
  ].join('\n');

  const result = redactSecrets(text);

  assert.equal(result.redacted, true);
  assert.ok(!result.text.includes('hunter2'));
  assert.ok(!result.text.includes('sk-live-0123456789abcdef'));
  assert.ok(!/(^|[^A-Za-z0-9_-])sk-abcdefghijklmnopqrstuvwxyz/.test(result.text));
  assert.ok(!result.text.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.deepEqual(
    result.redactions.map((entry) => entry.rule).sort(),
    ['bearer-token', 'credential-assignment', 'jwt', 'openai-key', 'url-credentials']
  );
});

test('the authorization header keeps its shape so a log line stays readable', () => {
  const result = redactSecrets('{"authorization": "Bearer whatever-value-here"}');

  assert.equal(result.redacted, true);
  assert.equal(result.text, '{"authorization": "[redacted]"}');
});

test('ordinary text is left alone', () => {
  const result = redactSecrets('the quick brown fox jumped over 42 lazy dogs');
  assert.equal(result.redacted, false);
  assert.deepEqual(result.redactions, []);
  assert.equal(result.text, 'the quick brown fox jumped over 42 lazy dogs');
});

test('the default rules are reusable across calls', () => {
  // Rules carry the `g` flag, so a stale lastIndex would skip every other match.
  const first = redactSecrets('sk-abcdefghijklmnopqrstuvwxyz');
  const second = redactSecrets('sk-abcdefghijklmnopqrstuvwxyz');

  assert.equal(first.redacted, true);
  assert.equal(second.redacted, true);
  assert.equal(second.text, first.text);
  assert.ok(DEFAULT_REDACTION_RULES.length > 0);
});

test('redaction walks a nested structure and preserves its shape', () => {
  const { value, redacted } = redactValue({
    toolOutput: { headers: { authorization: 'Bearer abcdefghijklmnop' }, count: 2 },
    notes: ['fine', 'token=abcdefghijklmnopqrstuvwx'],
    ok: true
  });

  assert.equal(redacted, true);
  assert.equal(value.toolOutput.count, 2);
  assert.equal(value.ok, true);
  assert.equal(value.notes[0], 'fine');
  assert.equal(value.notes[1], 'token=[redacted]');
  assert.deepEqual(Object.keys(value), ['toolOutput', 'notes', 'ok']);
});

test('an audit reason is redacted before it is stored and hashed', () => {
  const event = createAuditEvent({
    type: 'policy.rolled-back',
    subject: 'deployment',
    subjectId: 'deploy-1',
    correlationId: 'correlation-1',
    reason: 'rolled back after DEEPSEEK_API_KEY=sk-live-0123456789abcdef leaked',
    at: AT
  });

  assert.ok(!event.reason.includes('sk-live-0123456789abcdef'));
  assert.match(event.reason, /\[redacted\]/);
  // The id covers what is actually stored, so it verifies against the redacted form.
  assert.match(event.eventId, /^[0-9a-f]{64}$/);
  assert.equal(createAuditEvent({ ...event, eventId: undefined }).reason, event.reason);
});

test('an audit event id covers its whole body', () => {
  const event = createAuditEvent({
    type: 'policy.rolled-back',
    subject: 'deployment',
    subjectId: 'deploy-1',
    correlationId: 'correlation-1',
    reason: 'operator rolled back',
    at: AT
  });

  assert.equal(verifyAuditEvent(event), true);
  assert.equal(verifyAuditEvent({ ...event, eventId: 'f'.repeat(64) }), false);
  // Every field the id covers. A hash over only part of the body — the type,
  // say — would leave the rest editable without a reader noticing.
  for (const change of [
    { type: 'policy.deployed' },
    { subject: 'session' },
    { subjectId: 'deploy-2' },
    { correlationId: 'correlation-2' },
    { at: '2026-01-02T00:00:00.000Z' },
    { reason: 'nothing happened' },
    { schemaVersion: 2 }
  ]) {
    assert.equal(verifyAuditEvent({ ...event, ...change }), false, JSON.stringify(change));
  }
  assert.equal(verifyAuditEvent({ ...event, operator: 'someone-else' }), false);
  // A field the event never had is an alteration, not something to ignore.
  assert.equal(verifyAuditEvent({ ...event, note: 'extra' }), false);
});

test('a recorded audit event cannot be rewritten through the reference it returns', () => {
  const log = new InMemoryAuditLog();
  const recorded = log.record({
    type: 'policy.deployed',
    subject: 'deployment',
    subjectId: 'deploy-1',
    correlationId: 'correlation-1',
    reason: 'approved',
    at: AT
  });

  assert.equal(Object.isFrozen(recorded), true);
  assert.throws(() => {
    recorded.reason = 'rewritten';
  }, TypeError);
  assert.equal(log.list()[0].reason, 'approved');
  assert.equal(verifyAuditEvent(log.list()[0]), true);
});

// ------------------------------------------------------------- access control

test('the default policy denies anything it does not grant', () => {
  const operator = { principalId: 'operator-1', roles: ['operator'] };

  assert.equal(checkAccess(DEFAULT_ACCESS_POLICY, operator, 'evolve').allowed, true);
  assert.equal(checkAccess(DEFAULT_ACCESS_POLICY, operator, 'rollback').allowed, true);
  // Proposing a candidate and putting it live are separate grants.
  assert.equal(checkAccess(DEFAULT_ACCESS_POLICY, operator, 'approve').allowed, false);
  assert.equal(checkAccess(DEFAULT_ACCESS_POLICY, operator, 'deploy').allowed, false);

  const approver = { principalId: 'approver-1', roles: ['approver'] };
  assert.equal(checkAccess(DEFAULT_ACCESS_POLICY, approver, 'approve').allowed, true);
  assert.equal(checkAccess(DEFAULT_ACCESS_POLICY, approver, 'deploy').allowed, true);
  assert.equal(checkAccess(DEFAULT_ACCESS_POLICY, approver, 'evolve').allowed, false);
});

test('a principal with no roles, or no identity, is denied', () => {
  assert.equal(checkAccess(DEFAULT_ACCESS_POLICY, { principalId: 'nobody', roles: [] }, 'evolve').allowed, false);
  assert.throws(
    () => assertAccess(DEFAULT_ACCESS_POLICY, { principalId: '  ', roles: ['admin'] }, 'deploy'),
    /no identity/
  );
});

test('an action missing from the policy is denied rather than assumed permitted', () => {
  const policy = { superuserRole: 'admin', grants: {} };
  const admin = { principalId: 'admin-1', roles: ['admin'] };

  assert.equal(checkAccess(policy, admin, 'deploy').allowed, true, 'the break-glass role still works');
  assert.throws(
    () => assertAccess(policy, { principalId: 'operator-1', roles: ['operator'] }, 'deploy'),
    /no policy entry for deploy/
  );
  assert.equal(GOVERNED_ACTIONS.length, 6);
});

test('the admin role is break-glass and covers every governed action', () => {
  const admin = { principalId: 'admin-1', roles: ['admin'] };
  for (const action of GOVERNED_ACTIONS) {
    assert.equal(checkAccess(DEFAULT_ACCESS_POLICY, admin, action).allowed, true, action);
  }
});

// ------------------------------------------------------ access on the writer

function deploymentFixture(principal, registry = new PolicyRegistry(new InMemoryPolicyRegistryStore())) {
  const artifact = createPolicyArtifact({
    version: 'v1',
    parentVersion: null,
    source: 'export const decide = () => 1;',
    manifest: { entrypoint: 'src/policy.ts', dependencies: [], schemaVersion: 1 },
    allowedCapabilities: ['scheduling'],
    createdBy: 'human',
    createdAt: AT
  });
  registry.registerPolicy(artifact);
  const evaluation = createEvaluationReport({
    evaluatorVersion: '0.1.0',
    sourceHash: artifact.sourceSha256,
    snapshotId: 'b'.repeat(64),
    policyArtifactId: artifact.artifactId,
    split: 'holdout',
    configHash: 'c'.repeat(64),
    metrics: { quality: 1, cost: 0.1, parallelEfficiency: 1, missRate: 0, score: 1 },
    caseResults: [{ caseId: 'c1', taskFamily: 'packing', split: 'holdout', outcome: 'passed', quality: 1, score: 1 }],
    sampleCount: 1,
    passed: true,
    guardResults: [],
    createdAt: AT
  });
  registry.registerEvaluation(evaluation);

  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-governance-'));
  const writer = new DeploymentWriter({
    registry,
    lock: new SingleWriterLock(join(dir, 'deployment.lock'), 30_000),
    audit: new InMemoryAuditLog(),
    principal,
    signatureVerifier: { verify: () => ({ valid: true }), verifyReport: () => ({ valid: true }) }
  });
  return { registry, artifact, evaluation, writer, dir };
}

test('a writer acting as an operator cannot approve or deploy', () => {
  const context = deploymentFixture({ principalId: 'operator-1', roles: ['operator'] });
  try {
    const proposed = context.writer.propose({
      policyArtifactId: context.artifact.artifactId,
      evaluationId: context.evaluation.evaluationId,
      holdoutGate: { passed: true, candidateEvaluationId: context.evaluation.evaluationId }
    });

    assert.throws(
      () => context.writer.decide(proposed.deploymentId, { approvalId: 'a1', operator: 'operator-1', decision: 'approved', decidedAt: AT }),
      /access denied for approve/
    );
    assert.throws(() => context.writer.startCanary(proposed.deploymentId), /access denied for deploy/);

    // A denial changes nothing.
    assert.equal(context.registry.listDeployments()[0].state, 'PROPOSED');
    assert.equal(context.registry.currentPolicyArtifactId(), null);
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test('a writer cannot record an approval made under another principal', () => {
  // Proposing needs `evolve`, approving needs `approve`; one principal may hold
  // both roles, but neither grant is implied by the other.
  const context = deploymentFixture({ principalId: 'approver-1', roles: ['operator', 'approver'] });
  try {
    const proposed = context.writer.propose({
      policyArtifactId: context.artifact.artifactId,
      evaluationId: context.evaluation.evaluationId,
      holdoutGate: { passed: true, candidateEvaluationId: context.evaluation.evaluationId }
    });

    assert.throws(
      () => context.writer.decide(proposed.deploymentId, { approvalId: 'a1', operator: 'someone-else', decision: 'approved', decidedAt: AT }),
      /approval names someone-else but this writer acts as approver-1/
    );
    assert.equal(context.registry.listDeployments()[0].state, 'PROPOSED');
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test('an approver can take a deployment all the way to active', () => {
  const context = deploymentFixture({ principalId: 'approver-1', roles: ['operator', 'approver'] });
  try {
    const proposed = context.writer.propose({
      policyArtifactId: context.artifact.artifactId,
      evaluationId: context.evaluation.evaluationId,
      holdoutGate: { passed: true, candidateEvaluationId: context.evaluation.evaluationId }
    });
    context.writer.decide(proposed.deploymentId, { approvalId: 'a1', operator: 'approver-1', decision: 'approved', decidedAt: AT });
    context.writer.startCanary(proposed.deploymentId);
    const active = context.writer.completeCanary(
      proposed.deploymentId,
      { quality: 1, errorRate: 0, latencyMs: 1, cost: 0.1, missRate: 0 },
      THRESHOLDS
    );

    assert.equal(active.state, 'ACTIVE');
    assert.equal(context.registry.currentPolicyArtifactId(), context.artifact.artifactId);
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ retention

test('retention is decided per artifact kind', () => {
  assert.equal(retentionFor(DEFAULT_RETENTION_POLICY, 'observation'), 7 * 24 * 60 * 60 * 1_000);
  assert.equal(retentionFor(DEFAULT_RETENTION_POLICY, 'sandbox-output'), 24 * 60 * 60 * 1_000);
  // The audit trail itself is never expired by policy.
  for (const kind of ['policy', 'tool', 'evaluation-report']) {
    assert.equal(retentionFor(DEFAULT_RETENTION_POLICY, kind), null, kind);
  }
  validateRetentionPolicy(DEFAULT_RETENTION_POLICY);
});

test('a retention below the floor is refused rather than making evidence vanish', () => {
  const policy = { ...DEFAULT_RETENTION_POLICY, byKind: { ...DEFAULT_RETENTION_POLICY.byKind, policy: 1_000 } };
  assert.throws(() => retentionFor(policy, 'policy'), /must be null or at least/);

  assert.throws(() => validateRetentionPolicy({ minimumRetentionMs: 0 }), /minimumRetentionMs must be positive/);
  assert.throws(
    () => validateRetentionPolicy({ ...DEFAULT_RETENTION_POLICY, defaultRetentionMs: 1 }),
    /defaultRetentionMs must be null or at least/
  );
});

test('a writer cannot shorten retention by passing its own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-retention-'));
  try {
    const store = new FileArtifactStore(dir, () => new Date(AT));
    const metadata = putWithRetention(store, DEFAULT_RETENTION_POLICY, {
      bytes: Buffer.from('observation'),
      kind: 'observation',
      mediaType: 'application/json',
      schemaVersion: 1
    });

    assert.equal(metadata.retentionUntil, new Date(Date.parse(AT) + 7 * 24 * 60 * 60 * 1_000).toISOString());

    const forever = putWithRetention(store, DEFAULT_RETENTION_POLICY, {
      bytes: Buffer.from('policy'),
      kind: 'policy',
      mediaType: 'application/json',
      schemaVersion: 1
    });
    assert.equal(forever.retentionUntil, null);

    // The parameter type omits `retentionMs`, but an untyped caller can pass it
    // anyway. For a kind retained indefinitely, a merged value would become the
    // retention and make the audit trail immediately prunable.
    const shortened = putWithRetention(store, DEFAULT_RETENTION_POLICY, {
      bytes: Buffer.from('policy-attacked'),
      kind: 'policy',
      mediaType: 'application/json',
      schemaVersion: 1,
      retentionMs: 1
    });
    assert.equal(shortened.retentionUntil, null);

    const lengthened = putWithRetention(store, DEFAULT_RETENTION_POLICY, {
      bytes: Buffer.from('observation-attacked'),
      kind: 'observation',
      mediaType: 'application/json',
      schemaVersion: 1,
      retentionMs: 365 * 24 * 60 * 60 * 1_000
    });
    assert.equal(lengthened.retentionUntil, new Date(Date.parse(AT) + 7 * 24 * 60 * 60 * 1_000).toISOString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a retention exactly at the minimum is allowed', () => {
  // The rule is that a *shorter* retention is refused, so the boundary value
  // itself is legal. A sweep mutation moved the comparison to `<=` and nothing
  // noticed, which would have made the documented minimum unusable.
  const policy = { defaultRetentionMs: null, minimumRetentionMs: 1_000, byKind: { observation: 1_000 } };
  assert.equal(retentionFor(policy, 'observation'), 1_000);
  assert.throws(() => retentionFor({ ...policy, byKind: { observation: 999 } }, 'observation'), /at least 1000ms/);
});

test('expired artifacts are listed without being deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-retention-'));
  try {
    const store = new FileArtifactStore(dir, () => new Date(AT));
    putWithRetention(store, DEFAULT_RETENTION_POLICY, {
      bytes: Buffer.from('observation'),
      kind: 'observation',
      mediaType: 'application/json',
      schemaVersion: 1
    });

    const later = new Date(Date.parse(AT) + 30 * 24 * 60 * 60 * 1_000).toISOString();
    const expired = expiredArtifacts(store, later);
    assert.equal(expired.length, 1);
    // Listed, not removed: deletion is an explicit operator act.
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].deletedAt, null);
    assert.deepEqual(expiredArtifacts(store, AT), []);
    assert.throws(() => expiredArtifacts(store, 'not-a-date'), /needs an ISO instant/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------ production policy drift

test('the documented safety defaults match the running configuration', () => {
  const policyPath = fileURLToPath(new URL('../PRODUCTION_POLICY.md', import.meta.url));
  const markdown = readFileSync(policyPath, 'utf8');
  const block = markdown.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(block, 'PRODUCTION_POLICY.md must contain a fenced json block');

  const documented = JSON.parse(block[1]);
  const config = resolveDreamRsiConfig({});

  for (const [path, expected] of Object.entries(documented)) {
    const actual = path.split('.').reduce((node, key) => node[key], config);
    assert.equal(actual, expected, `${path} is ${actual} but the policy documents ${expected}`);
  }

  // The policy must also document the two facts an operator relies on.
  assert.match(markdown, /Automatic deployment is off/);
  assert.match(markdown, /Approval is never implied/);
});

test('auto-deploy cannot be enabled without evolution, whatever the policy says', () => {
  assert.equal(resolveDreamRsiConfig({}).evolution.autoDeploy, false);
  assert.throws(() => resolveDreamRsiConfig({ evolution: { autoDeploy: true } }), /requires evolution.enabled/);
});
