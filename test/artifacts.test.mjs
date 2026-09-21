import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FileArtifactStore,
  InMemoryDiscoveryStore,
  MOCK_ENVIRONMENT_ID,
  MockEmbodiedBackend,
  MockEnvironmentAdapter,
  SQLiteDiscoveryStore,
  assertArtifactsVerified,
  createDreamRsiRuntime,
  pipelineSettings,
  planPolicy,
  resolveDreamRsiConfig,
  runEpisodePipeline
} from '../dist/index.js';

const SESSION_ID = 'session-1';

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-artifacts-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Same, but waits: the synchronous form tears the directory down mid-await. */
async function withTempDirAsync(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-artifacts-'));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function blobPath(rootDir, artifactId) {
  return join(rootDir, 'blobs', artifactId.slice(0, 2), artifactId);
}

test('identical bytes are one artifact and different bytes are another', () => {
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir);
    const first = store.put({ bytes: Buffer.from('observation'), kind: 'observation',
      mediaType: 'application/json', schemaVersion: 1 });
    const again = store.put({ bytes: Buffer.from('observation'), kind: 'observation',
      mediaType: 'application/json', schemaVersion: 1 });
    const other = store.put({ bytes: Buffer.from('different'), kind: 'observation',
      mediaType: 'application/json', schemaVersion: 1 });

    assert.equal(first.artifactId, again.artifactId);
    assert.equal(first.createdAt, again.createdAt, 'the first write wins');
    assert.notEqual(first.artifactId, other.artifactId);
    assert.equal(store.list().length, 2);
    assert.deepEqual(store.get(first.artifactId), Buffer.from('observation'));
  });
});

test('metadata records the media type, byte length, schema version, and retention', () => {
  withTempDir((dir) => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const store = new FileArtifactStore(dir, () => at);
    const metadata = store.put({
      bytes: Buffer.from('payload'),
      kind: 'observation',
      mediaType: 'image/png',
      schemaVersion: 2,
      retentionMs: 60_000
    });

    assert.equal(metadata.mediaType, 'image/png');
    assert.equal(metadata.byteLength, 7);
    assert.equal(metadata.schemaVersion, 2);
    assert.equal(metadata.createdAt, '2026-01-01T00:00:00.000Z');
    assert.equal(metadata.retentionUntil, '2026-01-01T00:01:00.000Z');
    assert.equal(metadata.deletedAt, null);
  });
});

test('put rejects empty bytes and a non-positive schema version', () => {
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir);
    assert.throws(() => store.put({ bytes: Buffer.alloc(0), kind: 'observation', mediaType: 'text/plain', schemaVersion: 1 }), /must not be empty/);
    assert.throws(() => store.put({ bytes: Buffer.from('x'), kind: 'observation', mediaType: 'text/plain', schemaVersion: 0 }), /positive integer/);
    assert.throws(() => store.put({ bytes: Buffer.from('x'), kind: 'observation', mediaType: '  ', schemaVersion: 1 }), /mediaType must not be empty/);
    assert.throws(() => store.put({ bytes: Buffer.from('x'), kind: 'nonsense', mediaType: 'text/plain', schemaVersion: 1 }), /unknown artifact kind/);
  });
});

test('verify re-hashes the stored blob rather than trusting the index', () => {
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir);
    const { artifactId } = store.put({
      bytes: Buffer.from('trusted observation'),
      kind: 'observation',
      mediaType: 'application/json',
      schemaVersion: 1
    });

    assert.equal(store.verify(artifactId).ok, true);

    // Tamper with the blob on disk; the index still claims it is intact.
    writeFileSync(blobPath(dir, artifactId), Buffer.from('tampered observation'));
    const tampered = store.verify(artifactId);
    assert.equal(tampered.ok, false);
    assert.equal(tampered.reason, 'checksum_mismatch');
    assert.match(tampered.detail, /blob hashes to/);
  });
});

test('verify distinguishes a missing blob from an unknown artifact', () => {
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir);
    const { artifactId } = store.put({ bytes: Buffer.from('x'), kind: 'observation', mediaType: 'text/plain', schemaVersion: 1 });
    rmSync(blobPath(dir, artifactId));

    assert.equal(store.verify(artifactId).reason, 'missing_blob');
    assert.equal(store.verify('a'.repeat(64)).reason, 'unknown');
  });
});

test('delete removes the blob, marks the metadata, and is idempotent', () => {
  withTempDir((dir) => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const store = new FileArtifactStore(dir, () => at);
    const { artifactId } = store.put({ bytes: Buffer.from('x'), kind: 'observation', mediaType: 'text/plain', schemaVersion: 1 });

    assert.equal(store.delete(artifactId), true);
    assert.equal(store.delete(artifactId), false);
    assert.equal(existsSync(blobPath(dir, artifactId)), false);
    assert.equal(store.get(artifactId), undefined);
    assert.equal(store.metadata(artifactId).deletedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(store.verify(artifactId).reason, 'deleted');

    // Re-putting the same content revives the artifact.
    const restored = store.put({ bytes: Buffer.from('x'), kind: 'observation', mediaType: 'text/plain', schemaVersion: 1 });
    assert.equal(restored.artifactId, artifactId);
    assert.equal(restored.deletedAt, null);
    assert.equal(store.verify(artifactId).ok, true);
  });
});

test('pruneExpired deletes only artifacts past their retention', () => {
  let clock = new Date('2026-01-01T00:00:00.000Z');
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir, () => clock);
    const expiring = store.put({ bytes: Buffer.from('old'), kind: 'observation', mediaType: 'text/plain', schemaVersion: 1, retentionMs: 1_000 });
    const kept = store.put({ bytes: Buffer.from('new'), kind: 'observation', mediaType: 'text/plain', schemaVersion: 1, retentionMs: 86_400_000 });
    const forever = store.put({ bytes: Buffer.from('forever'), kind: 'observation', mediaType: 'text/plain', schemaVersion: 1 });

    clock = new Date('2026-01-01T00:00:02.000Z');
    assert.deepEqual(store.pruneExpired(), [expiring.artifactId]);
    assert.equal(store.verify(kept.artifactId).ok, true);
    assert.equal(store.verify(forever.artifactId).ok, true);
  });
});

test('the index survives a reopen and still verifies its blobs', () => {
  withTempDir((dir) => {
    const first = new FileArtifactStore(dir);
    const { artifactId } = first.put({ bytes: Buffer.from('durable'), kind: 'policy', mediaType: 'text/plain', schemaVersion: 3 });

    const reopened = new FileArtifactStore(dir);
    assert.equal(reopened.metadata(artifactId).schemaVersion, 3);
    assert.deepEqual(reopened.get(artifactId), Buffer.from('durable'));
    assert.equal(reopened.verify(artifactId).ok, true);
  });
});

test('assertArtifactsVerified throws on the first artifact that fails', () => {
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir);
    const good = store.put({ bytes: Buffer.from('good'), kind: 'observation', mediaType: 'text/plain', schemaVersion: 1 });
    const bad = store.put({ bytes: Buffer.from('bad'), kind: 'observation', mediaType: 'text/plain', schemaVersion: 1 });
    writeFileSync(blobPath(dir, bad.artifactId), Buffer.from('corrupted'));

    assert.equal(assertArtifactsVerified(store, [good.artifactId]).length, 1);
    assert.throws(
      () => assertArtifactsVerified(store, [good.artifactId, bad.artifactId]),
      /checksum_mismatch/
    );
    assert.throws(() => assertArtifactsVerified(store, ['f'.repeat(64)]), /unknown/);
  });
});

test('readAll returns every node from both store implementations, ordered by nodeId', () => {
  const nodes = ['task-a:n2', 'task-a:n1', 'task-b:n1'].map((nodeId) => ({
    nodeId,
    taskId: nodeId.split(':')[0],
    parentId: null,
    policyVersion: 'policy-v1',
    environmentVersion: 'mock-room-v1@1',
    stateHash: `state-${nodeId}`,
    observationHash: `observation-${nodeId}`,
    actionType: 'move_relative',
    actionParams: { dx: 1 },
    result: { status: 'completed' },
    score: 1,
    tokenCost: 0,
    execTimeMs: 1,
    idempotencyKey: nodeId,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z'
  }));

  const memory = new InMemoryDiscoveryStore();
  for (const node of nodes) memory.append(node);
  assert.deepEqual(memory.readAll().map((node) => node.nodeId), ['task-a:n1', 'task-a:n2', 'task-b:n1']);

  withTempDir((dir) => {
    const sqlite = new SQLiteDiscoveryStore(join(dir, 'discovery.db'));
    // Insert out of order so ordering is the query's doing, not insertion order.
    for (const node of [nodes[1], nodes[2], nodes[0]]) sqlite.append(node);
    assert.deepEqual(sqlite.readAll().map((node) => node.nodeId), ['task-a:n1', 'task-a:n2', 'task-b:n1']);
    sqlite.close();
  });
});

function makePipelineOptions(runtime, overrides = {}) {
  return {
    task: {
      taskId: 'task-reach',
      goal: 'reach x=2',
      environmentId: MOCK_ENVIRONMENT_ID,
      policyVersion: 'policy-v1',
      budget: { maxSteps: 5, wallClockMs: 60_000 },
      metadata: {}
    },
    episodeId: 'episode-1',
    sessionId: SESSION_ID,
    adapter: runtime.adapter,
    store: runtime.store,
    guard: runtime.guard,
    policy: planPolicy([
      { actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } },
      { actionType: 'move_relative', parameters: { dx: 1, dy: 0, dz: 0 } }
    ]),
    isGoalReached: (observation) => observation.pose.x >= 2,
    settings: pipelineSettings(runtime),
    ...overrides
  };
}

test('snapshotSource store snapshots the persisted tree rather than the run in memory', async () => {
  const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
  try {
    const fromEpisode = await runEpisodePipeline(makePipelineOptions(runtime));
    // A fresh session, or the environment would still be at the goal from the
    // first run and the second episode would record nothing.
    const fromStore = await runEpisodePipeline(
      makePipelineOptions(runtime, { snapshotSource: 'store', episodeId: 'episode-2', sessionId: 'session-2' })
    );

    assert.equal(fromEpisode.outcome.nodes.length, 2);
    assert.equal(fromStore.outcome.nodes.length, 2);
    // The store still holds the first run's nodes, so its snapshot is larger.
    assert.equal(runtime.store.readAll().length, 4);
    const storeSplit = fromStore.snapshot.splits;
    assert.equal(storeSplit.train.length + storeSplit.validation.length + storeSplit.holdout.length, 4);
    assert.notEqual(fromStore.snapshot.snapshotId, fromEpisode.snapshot.snapshotId);
  } finally {
    runtime.dispose();
  }
});

test('the pipeline verifies artifacts before evaluating', async () => {
  await withTempDirAsync(async (dir) => {
    const artifacts = new FileArtifactStore(dir);
    const valid = artifacts.put({
      bytes: Buffer.from('{"observation":"room"}'),
      kind: 'observation',
      mediaType: 'application/json',
      schemaVersion: 1
    });
    const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
    try {
      const verified = await runEpisodePipeline(
        makePipelineOptions(runtime, { artifacts: { store: artifacts, artifactIds: [valid.artifactId] } })
      );
      assert.equal(verified.outcome.episode.status, 'completed');

      writeFileSync(blobPath(dir, valid.artifactId), Buffer.from('{"observation":"forged"}'));
      await assert.rejects(
        runEpisodePipeline(
          makePipelineOptions(runtime, {
            episodeId: 'episode-2',
            sessionId: 'session-2',
            artifacts: { store: artifacts, artifactIds: [valid.artifactId] }
          })
        ),
        /checksum_mismatch/
      );
    } finally {
      runtime.dispose();
    }
  });
});

test('the pipeline rejects an unknown artifact before the episode runs', async () => {
  await withTempDirAsync(async (dir) => {
    const artifacts = new FileArtifactStore(dir);
    const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
    try {
      await assert.rejects(
        runEpisodePipeline(
          makePipelineOptions(runtime, {
            adapter: new MockEnvironmentAdapter(new MockEmbodiedBackend()),
            artifacts: { store: artifacts, artifactIds: ['0'.repeat(64)] }
          })
        ),
        /unknown/
      );
    } finally {
      runtime.dispose();
    }
  });
});

test('the artifact index is a readable, stable file listing', () => {
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir);
    const { artifactId } = store.put({ bytes: Buffer.from('x'), kind: 'observation', mediaType: 'text/plain', schemaVersion: 1 });

    const written = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    assert.equal(written.length, 1);
    assert.equal(written[0].artifactId, artifactId);
  });
});
