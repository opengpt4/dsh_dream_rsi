import type { ArtifactKind, ArtifactMetadata, ArtifactStore, PutArtifactInput } from '../artifacts/store.js';

/**
 * Retention policy, applied when an artifact is written.
 *
 * Retention is recorded on the artifact rather than enforced on a timer:
 * `pruneExpired` only ever runs when an operator calls it, because unattended
 * deletion is an audit-trail hazard.
 */

export interface RetentionPolicy {
  /** Applied to a kind with no entry of its own. `null` means retain indefinitely. */
  readonly defaultRetentionMs: number | null;
  readonly byKind: Partial<Record<ArtifactKind, number | null>>;
  /** A shorter retention than this is refused, so no kind can be made to vanish immediately. */
  readonly minimumRetentionMs: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  defaultRetentionMs: null,
  minimumRetentionMs: 60 * 60 * 1_000,
  byKind: {
    // Observations carry environment detail; they age out fastest.
    observation: 7 * 24 * 60 * 60 * 1_000,
    'sandbox-output': 24 * 60 * 60 * 1_000,
    'llm-response': 30 * 24 * 60 * 60 * 1_000,
    // Policy, tool, and evaluation artifacts are the audit trail itself.
    policy: null,
    tool: null,
    'evaluation-report': null
  }
};

/** Retention for one kind. `null` means retain indefinitely. */
export function retentionFor(policy: RetentionPolicy, kind: ArtifactKind): number | null {
  const configured = kind in policy.byKind ? policy.byKind[kind] : policy.defaultRetentionMs;
  if (configured === null || configured === undefined) return null;
  if (!Number.isFinite(configured) || configured < policy.minimumRetentionMs) {
    throw new Error(
      `retention for ${kind} must be null or at least ${policy.minimumRetentionMs}ms, received ${String(configured)}`
    );
  }
  return configured;
}

export function validateRetentionPolicy(policy: RetentionPolicy): void {
  if (!Number.isFinite(policy.minimumRetentionMs) || policy.minimumRetentionMs <= 0) {
    throw new Error('minimumRetentionMs must be positive');
  }
  if (policy.defaultRetentionMs !== null && policy.defaultRetentionMs < policy.minimumRetentionMs) {
    throw new Error('defaultRetentionMs must be null or at least minimumRetentionMs');
  }
  for (const kind of Object.keys(policy.byKind) as ArtifactKind[]) {
    retentionFor(policy, kind);
  }
}

/**
 * Write an artifact under a retention policy.
 *
 * The caller cannot shorten retention by passing its own `retentionMs`: the
 * policy decides, so a tool cannot arrange for its own evidence to expire.
 */
export function putWithRetention(
  store: ArtifactStore,
  policy: RetentionPolicy,
  input: Omit<PutArtifactInput, 'retentionMs'>
): ArtifactMetadata {
  validateRetentionPolicy(policy);
  const retentionMs = retentionFor(policy, input.kind);
  return store.put({ ...input, ...(retentionMs !== null ? { retentionMs } : {}) });
}

/** Artifacts past their retention, without deleting them. */
export function expiredArtifacts(
  store: ArtifactStore,
  at: string = new Date().toISOString()
): readonly ArtifactMetadata[] {
  const cutoff = Date.parse(at);
  if (Number.isNaN(cutoff)) throw new Error(`expiredArtifacts needs an ISO instant, received ${at}`);
  return store
    .list()
    .filter((artifact) => artifact.deletedAt === null && artifact.retentionUntil !== null)
    .filter((artifact) => Date.parse(artifact.retentionUntil!) <= cutoff);
}
