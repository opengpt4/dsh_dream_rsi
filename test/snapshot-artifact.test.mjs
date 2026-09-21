import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  Ed25519SignatureVerifier,
  FileArtifactStore,
  createEvaluationSnapshot,
  loadEvaluationSnapshot,
  persistEvaluationSnapshot,
  signEvaluationSnapshot,
  verifyEvaluationSnapshot
} from '../dist/index.js';
import { retentionFor, DEFAULT_RETENTION_POLICY } from '../dist/governance/retention.js';

const AT = '2026-01-01T00:00:00.000Z';

function node(nodeId, extra = {}) {
  return {
    nodeId,
    taskId: 'task-1',
    parentId: null,
    policyVersion: 'v1',
    environmentVersion: 'mock-room-v1',
    stateHash: `state-${nodeId}`,
    observationHash: `observation-${nodeId}`,
    actionType: 'move_relative',
    actionParams: { dx: 1, dy: 0, dz: 0 },
    result: { success: true },
    score: 0.8,
    tokenCost: 1,
    execTimeMs: 1,
    idempotencyKey: `key-${nodeId}`,
    schemaVersion: 1,
    createdAt: AT,
    ...extra
  };
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  };
}

const snapshotOf = (...nodes) => createEvaluationSnapshot(nodes, undefined, AT);

/** The layout `FileArtifactStore` files blobs under, mirrored from its tests. */
const blobPath = (dir, artifactId) => join(dir, 'blobs', artifactId.slice(0, 2), artifactId);

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-snapshot-'));
  try {
    return run(new FileArtifactStore(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- persistence

test('a snapshot round-trips through the store under its own kind', () => {
  withStore((store) => {
    const snapshot = snapshotOf(node('a'), node('b'));
    const ref = persistEvaluationSnapshot(store, snapshot);

    const metadata = store.metadata(ref.artifactId);
    assert.equal(metadata.kind, 'snapshot');
    // Evidence, not an observation: a report's claim about which snapshot it
    // evaluated is only checkable while the snapshot can still be retrieved.
    assert.equal(retentionFor(DEFAULT_RETENTION_POLICY, 'snapshot'), null);

    const loaded = loadEvaluationSnapshot(store, ref);
    assert.equal(loaded.snapshotId, snapshot.snapshotId);
    assert.deepEqual(loaded.splits, snapshot.splits);
    assert.equal(verifyEvaluationSnapshot(loaded), true);
  });
});

test('the same snapshot is the same artifact, and a different tree is not', () => {
  withStore((store) => {
    const first = persistEvaluationSnapshot(store, snapshotOf(node('a')));
    const again = persistEvaluationSnapshot(store, snapshotOf(node('a')));
    const other = persistEvaluationSnapshot(store, snapshotOf(node('b')));

    assert.equal(again.artifactId, first.artifactId);
    assert.notEqual(other.artifactId, first.artifactId);
  });
});

test('a rewritten blob is refused by the store check, before any parsing', () => {
  withStore((store, dir) => {
    const ref = persistEvaluationSnapshot(store, snapshotOf(node('a')));
    // The id is the name the bytes are filed under, so editing the file leaves
    // the record claiming an identity its content no longer has.
    writeFileSync(blobPath(dir, ref.artifactId), Buffer.from('{"snapshotId":"whatever"}', 'utf8'));

    assert.throws(() => loadEvaluationSnapshot(store, ref), /failed verification: checksum_mismatch/);
  });
});

test('a snapshot edited without touching its id is refused', () => {
  withStore((store) => {
    const ref = persistEvaluationSnapshot(store, snapshotOf(node('a'), node('b')));
    // Rewrite the record so its body no longer hashes to the id it carries, and
    // file it under the name its *new* bytes hash to. The store check passes —
    // those bytes are what that name means — so the id recomputation is what
    // refuses it.
    const tampered = JSON.parse(store.get(ref.artifactId).toString('utf8'));
    // Emptied rather than moved between buckets: both nodes share a task id, so
    // one bucket holds them and clearing all three is guaranteed to change the
    // content the id covers.
    tampered.splits = { train: [], validation: [], holdout: [] };
    assert.equal(verifyEvaluationSnapshot({ ...tampered, schemaVersion: 1 }), false, 'the tamper must change the id');
    const replacement = store.put({
      bytes: Buffer.from(JSON.stringify(tampered), 'utf8'),
      kind: 'snapshot',
      mediaType: 'application/json',
      schemaVersion: 1
    });

    assert.throws(() => loadEvaluationSnapshot(store, replacement), /does not match its content/);
  });
});

test('a missing snapshot is reported rather than returned undefined', () => {
  withStore((store) => {
    const ref = persistEvaluationSnapshot(store, snapshotOf(node('a')));
    store.delete(ref.artifactId);

    assert.throws(() => loadEvaluationSnapshot(store, ref), /failed verification: deleted/);
  });
});

// --------------------------------------------------------------- signing

test('a signed snapshot verifies, and signing keeps its id and its freeze', () => {
  const keys = keyPair();
  const unsigned = snapshotOf(node('a'));
  const signed = signEvaluationSnapshot(unsigned, { privateKeyPem: keys.privateKeyPem, keyId: 'rotate-2026', now: () => new Date(AT) });

  assert.equal(signed.snapshotId, unsigned.snapshotId);
  assert.equal(Object.isFrozen(signed), true, 'a signed snapshot is still immutable');
  assert.equal(signed.signature.signedAt, AT);

  const verifier = new Ed25519SignatureVerifier({ keys: [{ keyId: 'rotate-2026', publicKeyPem: keys.publicKeyPem }] });
  withStore((store) => {
    const ref = persistEvaluationSnapshot(store, signed);
    assert.deepEqual(verifier.verifySnapshot(signed), { valid: true });
    assert.equal(loadEvaluationSnapshot(store, ref, verifier).snapshotId, signed.snapshotId);
    // No verifier means no signature requirement; a reader with a ring gets the
    // check, and one without is not silently told the snapshot is signed.
    assert.equal(loadEvaluationSnapshot(store, ref).snapshotId, signed.snapshotId);
  });
});

test('a snapshot reader with a ring refuses an unsigned or tampered record', () => {
  const keys = keyPair();
  const verifier = new Ed25519SignatureVerifier({ keys: [{ keyId: 'k1', publicKeyPem: keys.publicKeyPem }] });

  withStore((store) => {
    const unsigned = persistEvaluationSnapshot(store, snapshotOf(node('a')));
    assert.throws(
      () => loadEvaluationSnapshot(store, unsigned, verifier),
      /failed signature verification: the snapshot is unsigned/
    );

    const signed = signEvaluationSnapshot(snapshotOf(node('b')), { privateKeyPem: keys.privateKeyPem, keyId: 'stranger' });
    const foreign = persistEvaluationSnapshot(store, signed);
    assert.throws(
      () => loadEvaluationSnapshot(store, foreign, verifier),
      /failed signature verification: no key stranger is in the key ring/
    );
  });
});

test('the snapshot signer refuses a record whose body does not match its id', () => {
  const keys = keyPair();
  const tampered = { ...snapshotOf(node('a')), snapshotId: 'f'.repeat(64) };

  assert.throws(
    () => signEvaluationSnapshot(tampered, { privateKeyPem: keys.privateKeyPem, keyId: 'k1' }),
    /refusing to sign snapshot .* body does not match its id/
  );
});
