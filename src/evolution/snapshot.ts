import { createHash } from 'node:crypto';

import type { ArtifactRef, ArtifactStore } from '../artifacts/store.js';
import type { DiscoveryNode } from '../discovery/models.js';
import type { ArtifactSignature } from '../registry/models.js';
import type { SignatureVerdict } from '../registry/deployment-writer.js';
import { splitDiscoveryNodes, type EvaluationSplit, type EvaluationSplitConfig } from './split.js';

export interface EvaluationSnapshot {
  readonly snapshotId: string;
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly splits: EvaluationSplit;
  /**
   * Detached signature over {@link EvaluationSnapshot.snapshotId}.
   *
   * Attached by {@link signEvaluationSnapshot} rather than by the constructor:
   * the id has to exist before anything can sign it, and `createdAt` is outside
   * the id because two snapshots of the same tree are the same tree.
   */
  readonly signature?: ArtifactSignature;
}

/**
 * Freeze a node set into an evaluation snapshot.
 *
 * `snapshotId` covers the content and nothing else. `createdAt` is recorded on
 * the snapshot but excluded from the id: including it would mean two snapshots
 * of the identical tree never shared an id, so nothing could tell "the same
 * tree" from "a different tree at a different time", and the id would not be a
 * content address. Node-level `createdAt` values are already part of the
 * content, so the identity still covers when the work happened.
 */
export function createEvaluationSnapshot(
  nodes: readonly DiscoveryNode[],
  config?: EvaluationSplitConfig,
  createdAt = new Date().toISOString()
): EvaluationSnapshot {
  const clonedNodes = nodes.map((node) => cloneAndFreeze(node));
  const splits = splitDiscoveryNodes(clonedNodes, config);
  const snapshotId = createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, splits }))
    .digest('hex');
  return deepFreeze({ snapshotId, schemaVersion: 1, createdAt, splits });
}

function cloneAndFreeze<T extends object>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Recompute the id from the content it covers. `createdAt` is not identity. */
export function verifyEvaluationSnapshot(snapshot: EvaluationSnapshot): boolean {
  return snapshot.snapshotId === snapshotIdOf(snapshot);
}

function snapshotIdOf(snapshot: Pick<EvaluationSnapshot, 'schemaVersion' | 'splits'>): string {
  return createHash('sha256')
    .update(JSON.stringify({ schemaVersion: snapshot.schemaVersion, splits: snapshot.splits }))
    .digest('hex');
}

/** The bytes a snapshot is stored as. Canonical: the same snapshot is the same bytes. */
export function snapshotBytes(snapshot: EvaluationSnapshot): Buffer {
  return Buffer.from(`${JSON.stringify(snapshotJson(snapshot), null, 2)}\n`, 'utf8');
}

/** The record without its signature, which is stored beside it rather than part of it. */
function snapshotJson(snapshot: EvaluationSnapshot): unknown {
  const { signature, ...body } = snapshot;
  return signature === undefined ? body : { ...body, signature };
}

/**
 * Store a snapshot and return the reference to it.
 *
 * Stored under its own kind so retention treats it as evidence rather than as
 * an observation. The bytes are canonical, so the same snapshot is always the
 * same artifact, and the store's own digest covers them: a rewritten file is
 * refused by `ArtifactStore.get` before anything parses it.
 */
export function persistEvaluationSnapshot(store: ArtifactStore, snapshot: EvaluationSnapshot): ArtifactRef {
  return store.put({
    bytes: snapshotBytes(snapshot),
    kind: 'snapshot',
    mediaType: 'application/json',
    schemaVersion: snapshot.schemaVersion
  });
}

/**
 * Read a snapshot back and re-check it.
 *
 * Three checks, in this order: the bytes match the reference's digest (the
 * store's job), the record's body hashes to the `snapshotId` it claims, and —
 * when a verifier is given and the record carries a signature — the signature
 * holds. A snapshot whose `splits` were edited and whose id was edited to match
 * fails the first; one edited without touching the id fails the second.
 */
export function loadEvaluationSnapshot(
  store: ArtifactStore,
  ref: ArtifactRef,
  verifier?: SnapshotSignatureVerifier
): EvaluationSnapshot {
  // The store's own check first: `get` returns whatever bytes are on disk, so a
  // rewritten blob is caught here rather than by the id check below, which only
  // sees a record that may have been rewritten consistently.
  const verification = store.verify(ref.artifactId);
  if (!verification.ok) {
    throw new Error(`snapshot ${ref.artifactId} failed verification: ${verification.reason} (${verification.detail})`);
  }
  const bytes = store.get(ref.artifactId);
  if (bytes === undefined) throw new Error(`snapshot ${ref.artifactId} is not in the store`);
  const snapshot = JSON.parse(bytes.toString('utf8')) as EvaluationSnapshot;
  if (!verifyEvaluationSnapshot(snapshot)) {
    throw new Error(`snapshot ${snapshot.snapshotId} does not match its content`);
  }
  if (verifier !== undefined) {
    const verdict = verifier.verifySnapshot(snapshot);
    if (!verdict.valid) throw new Error(`snapshot ${snapshot.snapshotId} failed signature verification: ${verdict.reason}`);
  }
  return snapshot;
}

/** The part of the signing scheme a snapshot reader needs. */
export interface SnapshotSignatureVerifier {
  verifySnapshot(snapshot: EvaluationSnapshot): SignatureVerdict;
}
