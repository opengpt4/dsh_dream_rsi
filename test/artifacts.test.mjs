import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  InMemoryPolicyRegistryStore,
  PolicyRegistry,
  createPolicyArtifact,
  hashDreamRsiConfig,
  loadEvaluationSnapshot,
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

test('the same bytes cannot be filed under two kinds', () => {
  // One blob carries one record, so a second kind cannot be filed over the
  // first — and the kind decides retention. The case that matters is the audit
  // trail: storing a policy after the same bytes were stored as an observation
  // silently returned the observation, so the policy would have expired in seven
  // days. Refusing is the honest answer; a store that must hold one blob under
  // two kinds needs per-kind records rather than a silent collision.
  const AT = '2026-01-01T00:00:00.000Z';
  const week = 7 * 24 * 60 * 60 * 1_000;
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir, () => new Date(AT));
    const observation = store.put({
      bytes: Buffer.from('the same bytes'),
      kind: 'observation',
      mediaType: 'text/plain',
      schemaVersion: 1,
      retentionMs: week
    });
    assert.equal(observation.retentionUntil, new Date(Date.parse(AT) + week).toISOString());

    assert.throws(
      () =>
        store.put({
          bytes: Buffer.from('the same bytes'),
          kind: 'policy',
          mediaType: 'text/plain',
          schemaVersion: 1
        }),
      /already stored as observation; the same bytes cannot also be stored as policy/
    );

    // Nothing was written over: still one record, still the observation's retention.
    assert.equal(store.list().length, 1);
    assert.equal(store.metadata(observation.artifactId).kind, 'observation');
    assert.equal(store.metadata(observation.artifactId).retentionUntil, observation.retentionUntil);
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

test('verify catches a metadata byte length that disagrees with the blob', () => {
  // Metadata is the only mutable state in the store, so it is the part that can
  // be edited independently of the bytes. A length that disagrees with the blob
  // is a record that no longer describes what it points at.
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir);
    const { artifactId } = store.put({
      bytes: Buffer.from('seven!!'),
      kind: 'observation',
      mediaType: 'text/plain',
      schemaVersion: 1
    });
    assert.equal(store.verify(artifactId).ok, true);

    const metadataPath = join(dir, 'metadata', `${artifactId}.json`);
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, byteLength: 999 }));

    const verdict = store.verify(artifactId);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'checksum_mismatch');
    assert.match(verdict.detail, /metadata says 999/);
  });
});

test('verification compares the whole digest, not a prefix', () => {
  // `verify` looks the record up by the id it is given, so a corrupted id cannot
  // reach the comparison at all — the field itself has to disagree with the blob
  // for the comparison to run. The last character is enough to tell a whole-value
  // comparison from a prefix one, without needing a prefix collision.
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir);
    const { artifactId } = store.put({
      bytes: Buffer.from('whole digest'),
      kind: 'observation',
      mediaType: 'text/plain',
      schemaVersion: 1
    });
    assert.equal(store.verify(artifactId).ok, true);

    const metadataPath = join(dir, 'metadata', `${artifactId}.json`);
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    const flipped = metadata.artifactId.slice(0, -1) + (metadata.artifactId.endsWith('0') ? '1' : '0');
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, artifactId: flipped }));

    const verdict = store.verify(artifactId);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'checksum_mismatch');
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

test('the pipeline stores the snapshot it evaluated and the report points at it', async () => {
  await withTempDirAsync(async (dir) => {
    const artifacts = new FileArtifactStore(dir);
    const runtime = createDreamRsiRuntime(resolveDreamRsiConfig({ storage: { sqlitePath: ':memory:' } }));
    try {
      const registry = new PolicyRegistry(new InMemoryPolicyRegistryStore());
      const artifact = createPolicyArtifact({
        version: 'v1',
        parentVersion: null,
        source: 'export const decide = () => 1;',
        manifest: { entrypoint: 'src/policy.ts', dependencies: [], schemaVersion: 1 },
        allowedCapabilities: ['scheduling'],
        createdBy: 'human',
        createdAt: '2026-01-01T00:00:00.000Z'
      });
      registry.registerPolicy(artifact);
      const reporting = {
        registry,
        policyArtifactId: artifact.artifactId,
        evaluatorVersion: '0.1.0',
        sourceHash: artifact.sourceSha256,
        configHash: hashDreamRsiConfig(runtime.config),
        split: 'validation',
        taskFamily: 'mock-room'
      };

      const run = await runEpisodePipeline(
        makePipelineOptions(runtime, { artifacts: { store: artifacts, artifactIds: [] }, reporting })
      );

      // The report says which snapshot it evaluated; the reference is where
      // that snapshot can be read back from.
      assert.equal(run.report.snapshotId, run.snapshot.snapshotId);
      assert.ok(run.report.snapshotRef, 'a run with a store must record where the snapshot went');
      const loaded = loadEvaluationSnapshot(artifacts, run.report.snapshotRef);
      assert.equal(loaded.snapshotId, run.report.snapshotId, 'the stored snapshot must be the one the report names');
      assert.deepEqual(loaded.splits, run.snapshot.splits);

      // Without a store there is nothing to point at, and nothing is written.
      const bare = await runEpisodePipeline(
        makePipelineOptions(runtime, {
          episodeId: 'episode-2',
          sessionId: 'session-2',
          reporting
        })
      );
      assert.equal(bare.report.snapshotRef, undefined);
      assert.equal('snapshotRef' in bare.report, false);
      assert.equal(registry.listEvaluations().length, 2);
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

test('each artifact keeps its metadata in its own file', () => {
  withTempDir((dir) => {
    const store = new FileArtifactStore(dir);
    const { artifactId } = store.put({ bytes: Buffer.from('x'), kind: 'observation', mediaType: 'text/plain', schemaVersion: 1 });

    // One file per artifact rather than one index: a shared index cannot be
    // written by two stores without one dropping the other's entries.
    const written = JSON.parse(readFileSync(join(dir, 'metadata', `${artifactId}.json`), 'utf8'));
    assert.equal(written.artifactId, artifactId);
    assert.equal(readdirSync(join(dir, 'metadata')).length, 1);
  });
});

test('two stores sharing a directory do not drop each other\'s artifacts', () => {
  withTempDir((dir) => {
    const first = new FileArtifactStore(dir);
    const second = new FileArtifactStore(dir);

    const a = first.put({ bytes: Buffer.from('from A'), kind: 'observation', mediaType: 'text/plain', schemaVersion: 1 });
    const b = second.put({ bytes: Buffer.from('from B'), kind: 'observation', mediaType: 'text/plain', schemaVersion: 1 });

    // Both artifacts survive, and a store loaded afterwards sees both. A single
    // index file lost one of them, leaving a blob with no metadata and no way
    // to verify it.
    assert.equal(first.list().length, 2);
    assert.equal(second.list().length, 2);
    assert.equal(new FileArtifactStore(dir).list().length, 2);
    assert.equal(first.verify(a.artifactId).ok, true);
    assert.equal(second.verify(b.artifactId).ok, true);
  });
});

test('one store sees an artifact another deleted', () => {
  withTempDir((dir) => {
    const first = new FileArtifactStore(dir);
    const second = new FileArtifactStore(dir);
    const { artifactId } = first.put({ bytes: Buffer.from('shared'), kind: 'observation', mediaType: 'text/plain', schemaVersion: 1 });

    second.delete(artifactId);
    assert.equal(first.verify(artifactId).reason, 'deleted');
    assert.equal(first.get(artifactId), undefined);
  });
});
