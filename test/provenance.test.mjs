import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FileArtifactStore,
  InMemoryDiscoveryStore,
  createEvaluationSnapshot,
  createPolicyArtifact,
  createPolicyArtifactWithSource,
  replayNodes,
  verifyPolicyArtifact,
  verifyPolicyArtifactSource
} from '../dist/index.js';

const AT = '2026-01-01T00:00:00.000Z';

const MANIFEST = { entrypoint: 'src/policy.ts', dependencies: [], schemaVersion: 1 };

function policyInput(source = 'export const decide = () => 1;', version = 'v1') {
  return {
    version,
    parentVersion: version === 'v1' ? null : 'v1',
    source,
    manifest: MANIFEST,
    allowedCapabilities: ['scheduling'],
    createdBy: 'human',
    createdAt: AT
  };
}

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-provenance-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ sourceRef

test('a policy artifact can carry a retrievable reference to its own source', () => {
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir);
    const artifact = createPolicyArtifactWithSource(store, policyInput('export const decide = () => 42;'));

    assert.ok(artifact.sourceRef, 'the source must be retrievable, not just hashed');
    assert.equal(artifact.sourceRef.kind, 'policy');
    assert.equal(artifact.sourceRef.mediaType, 'text/plain');
    assert.equal(artifact.sourceRef.byteLength, Buffer.byteLength('export const decide = () => 42;'));
    assert.equal(store.get(artifact.sourceRef.artifactId).toString('utf8'), 'export const decide = () => 42;');
    assert.equal(verifyPolicyArtifactSource(artifact, store), true);
  });
});

test('a reference is a location, not part of the artifact identity', () => {
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir);
    const withSource = createPolicyArtifactWithSource(store, policyInput());
    const withoutSource = createPolicyArtifact(policyInput());

    // Same content, same id: where the bytes live must not change what the
    // artifact is, or the same policy would have two identities.
    assert.equal(withSource.artifactId, withoutSource.artifactId);
    assert.equal(verifyPolicyArtifact(withSource), true);
    assert.equal(withoutSource.sourceRef, undefined);
  });
});

test('a reference that points at other content fails the source check', () => {
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir);
    const artifact = createPolicyArtifactWithSource(store, policyInput('export const decide = () => 1;'));

    // Point the reference at a different, valid artifact.
    const other = store.put({
      bytes: Buffer.from('export const decide = () => 999;'),
      kind: 'policy',
      mediaType: 'text/plain',
      schemaVersion: 1
    });
    const forged = { ...artifact, sourceRef: { ...artifact.sourceRef, artifactId: other.artifactId } };

    assert.equal(verifyPolicyArtifactSource(forged, store), false);
    // The identity still verifies, because the reference is not part of it —
    // which is exactly why the source check has to exist separately.
    assert.equal(verifyPolicyArtifact(forged), true);
  });
});

test('a reference to a deleted or tampered blob fails the source check', () => {
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir);
    const artifact = createPolicyArtifactWithSource(store, policyInput());

    writeFileSync(join(dir, 'blobs', artifact.sourceRef.artifactId.slice(0, 2), artifact.sourceRef.artifactId), 'tampered');
    assert.equal(verifyPolicyArtifactSource(artifact, store), false);
  });
});

test('an artifact without a reference reports its source as unretrievable', () => {
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir);
    assert.equal(verifyPolicyArtifactSource(createPolicyArtifact(policyInput()), store), false);
  });
});

// --------------------------------------------------------------- replay purity

/** Modules replay may read. Anything else is a capability replay does not get. */
const REPLAY_MODULES = [
  'dist/replay/simulator.js',
  'dist/replay/key.js',
  'dist/evolution/snapshot.js',
  'dist/evolution/split.js',
  'dist/evolution/evaluator.js'
];

const FORBIDDEN_IMPORTS = [
  'node:child_process',
  'node:net',
  'node:http',
  'node:https',
  'node:dgram',
  'node:tls',
  'node:vm',
  'node:worker_threads',
  'harness',
  'isolated-evaluator',
  'embodied/',
  'tools/',
  'candidate-generator',
  'policy-registry'
];

test('replay modules import no model client, tool, sandbox, or network capability', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));

  for (const modulePath of REPLAY_MODULES) {
    const source = readFileSync(join(root, modulePath), 'utf8');
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);

    for (const specifier of specifiers) {
      for (const forbidden of FORBIDDEN_IMPORTS) {
        assert.ok(
          !specifier.includes(forbidden),
          `${modulePath} imports ${specifier}, which ${forbidden} covers`
        );
      }
    }
    // Replay reads nothing from disk and spawns nothing.
    assert.ok(!/\brequire\(/.test(source), `${modulePath} uses require()`);
  }
});

test('replay leaves the source store and its nodes untouched', () => {
  const nodes = [0, 1, 2].map((index) => ({
    nodeId: `n-${index}`,
    taskId: 'task-1',
    parentId: index === 0 ? null : `n-${index - 1}`,
    policyVersion: 'v1',
    environmentVersion: 'mock-room-v1@1',
    stateHash: `state-${index}`,
    observationHash: `obs-${index}`,
    actionType: 'move_relative',
    actionParams: { dx: 1, dy: 0, dz: 0 },
    result: { actionId: `n-${index}`, status: 'completed' },
    score: 1,
    tokenCost: 0,
    execTimeMs: 1,
    idempotencyKey: `n-${index}`,
    schemaVersion: 1,
    createdAt: AT
  }));

  const store = new InMemoryDiscoveryStore();
  for (const node of nodes) store.append(node);
  const before = JSON.stringify(store.readAll());

  const snapshot = createEvaluationSnapshot(store.readAll(), undefined, AT);
  const { report } = replayNodes(store.readAll());

  assert.equal(report.hitCount, 3);
  // Deep-frozen: a replay cannot edit the tree it is scoring.
  assert.equal(Object.isFrozen(snapshot), true);
  assert.throws(() => {
    snapshot.splits.train[0].score = 99;
  }, TypeError);
  assert.equal(JSON.stringify(store.readAll()), before, 'replay mutated the source store');
});
