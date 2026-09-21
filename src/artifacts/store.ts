import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Content-addressed artifact storage.
 *
 * The blob path is derived from the SHA-256 of its bytes, so identical content
 * is stored once and a blob's name is also its checksum. Metadata is the only
 * mutable state: retention and deletion are recorded there rather than by
 * rewriting or truncating a blob.
 */

/** What the bytes are for, so retention and deletion can be reasoned about by category. */
export type ArtifactKind =
  | 'observation'
  | 'llm-response'
  | 'sandbox-output'
  | 'policy'
  | 'tool'
  | 'evaluation-report';

export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
  'observation',
  'llm-response',
  'sandbox-output',
  'policy',
  'tool',
  'evaluation-report'
];

export interface ArtifactMetadata {
  /** Lowercase SHA-256 of the stored bytes, and the name the blob is filed under. */
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly schemaVersion: number;
  readonly createdAt: string;
  /** Past this instant the artifact is eligible for `pruneExpired`. */
  readonly retentionUntil: string | null;
  readonly deletedAt: string | null;
}

export type ArtifactVerificationFailure =
  | 'unknown'
  | 'deleted'
  | 'missing_blob'
  | 'checksum_mismatch';

export type ArtifactVerification =
  | { readonly ok: true; readonly metadata: ArtifactMetadata }
  | {
      readonly ok: false;
      readonly artifactId: string;
      readonly reason: ArtifactVerificationFailure;
      readonly detail: string;
    };

/**
 * A pointer to stored bytes.
 *
 * Deliberately a subset of {@link ArtifactMetadata}: a record that references an
 * artifact needs the identity and the shape, not the retention bookkeeping.
 */
export interface ArtifactRef {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly schemaVersion: number;
}

export function toArtifactRef(metadata: ArtifactMetadata): ArtifactRef {
  return {
    artifactId: metadata.artifactId,
    kind: metadata.kind,
    mediaType: metadata.mediaType,
    byteLength: metadata.byteLength,
    schemaVersion: metadata.schemaVersion
  };
}

export interface PutArtifactInput {
  readonly bytes: Buffer;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly schemaVersion: number;
  /** Omitted means the artifact is retained indefinitely. */
  readonly retentionMs?: number;
}

export interface ArtifactStore {
  put(input: PutArtifactInput): ArtifactMetadata;
  get(artifactId: string): Buffer | undefined;
  metadata(artifactId: string): ArtifactMetadata | undefined;
  verify(artifactId: string): ArtifactVerification;
  delete(artifactId: string): boolean;
  pruneExpired(at?: string): readonly string[];
  list(): ArtifactMetadata[];
}

export class FileArtifactStore implements ArtifactStore {
  private readonly indexFilePath: string;
  private readonly blobRoot: string;
  private readonly entries = new Map<string, ArtifactMetadata>();

  constructor(rootDir: string, private readonly now: () => Date = () => new Date()) {
    this.indexFilePath = join(rootDir, 'index.json');
    this.blobRoot = join(rootDir, 'blobs');
    mkdirSync(this.blobRoot, { recursive: true });
    for (const entry of this.readIndex()) this.entries.set(entry.artifactId, entry);
  }

  put(input: PutArtifactInput): ArtifactMetadata {
    if (input.bytes.length === 0) throw new Error('artifact bytes must not be empty');
    if (input.mediaType.trim().length === 0) throw new Error('artifact mediaType must not be empty');
    if (!ARTIFACT_KINDS.includes(input.kind)) throw new Error(`unknown artifact kind ${input.kind}`);
    if (!Number.isInteger(input.schemaVersion) || input.schemaVersion <= 0) {
      throw new Error('artifact schemaVersion must be a positive integer');
    }

    const artifactId = createHash('sha256').update(input.bytes).digest('hex');
    const existing = this.entries.get(artifactId);
    // Identical content is one artifact; re-putting an undeleted one changes nothing.
    if (existing !== undefined && existing.deletedAt === null) return existing;

    const blobPath = this.blobPath(artifactId);
    if (!existsSync(blobPath)) {
      mkdirSync(dirname(blobPath), { recursive: true });
      // Write then rename, so a reader never observes a partial blob.
      const temporaryPath = `${blobPath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, input.bytes);
      renameSync(temporaryPath, blobPath);
    }

    const createdAt = this.now().toISOString();
    const metadata: ArtifactMetadata = {
      artifactId,
      kind: input.kind,
      mediaType: input.mediaType,
      byteLength: input.bytes.length,
      schemaVersion: input.schemaVersion,
      createdAt,
      retentionUntil: input.retentionMs === undefined
        ? null
        : new Date(this.now().getTime() + input.retentionMs).toISOString(),
      deletedAt: null
    };
    this.entries.set(artifactId, metadata);
    this.persist();
    return metadata;
  }

  get(artifactId: string): Buffer | undefined {
    const metadata = this.entries.get(artifactId);
    if (metadata === undefined || metadata.deletedAt !== null) return undefined;
    const blobPath = this.blobPath(artifactId);
    return existsSync(blobPath) ? readFileSync(blobPath) : undefined;
  }

  metadata(artifactId: string): ArtifactMetadata | undefined {
    return this.entries.get(artifactId);
  }

  /** Re-hash the stored blob and compare it with the name it is filed under. */
  verify(artifactId: string): ArtifactVerification {
    const metadata = this.entries.get(artifactId);
    if (metadata === undefined) return failed(artifactId, 'unknown', 'no metadata for this artifact');
    if (metadata.deletedAt !== null) return failed(artifactId, 'deleted', `deleted at ${metadata.deletedAt}`);

    const blobPath = this.blobPath(artifactId);
    if (!existsSync(blobPath)) return failed(artifactId, 'missing_blob', 'metadata exists but the blob does not');

    const bytes = readFileSync(blobPath);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== artifactId) return failed(artifactId, 'checksum_mismatch', `blob hashes to ${digest}`);
    if (bytes.length !== metadata.byteLength) {
      return failed(artifactId, 'checksum_mismatch', `blob is ${bytes.length} bytes, metadata says ${metadata.byteLength}`);
    }
    return { ok: true, metadata };
  }

  delete(artifactId: string): boolean {
    const metadata = this.entries.get(artifactId);
    if (metadata === undefined || metadata.deletedAt !== null) return false;
    rmSync(this.blobPath(artifactId), { force: true });
    this.entries.set(artifactId, { ...metadata, deletedAt: this.now().toISOString() });
    this.persist();
    return true;
  }

  /**
   * Delete every artifact past its retention. Never runs on its own: a
   * retention policy that fires without an operator is an audit-trail hazard.
   */
  pruneExpired(at: string = this.now().toISOString()): readonly string[] {
    const cutoff = Date.parse(at);
    if (Number.isNaN(cutoff)) throw new Error(`pruneExpired needs an ISO instant, received ${at}`);
    const expired = [...this.entries.values()]
      .filter((entry) => entry.deletedAt === null && entry.retentionUntil !== null)
      .filter((entry) => Date.parse(entry.retentionUntil!) <= cutoff)
      .map((entry) => entry.artifactId);
    for (const artifactId of expired) this.delete(artifactId);
    return expired;
  }

  list(): ArtifactMetadata[] {
    return [...this.entries.values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  }

  private blobPath(artifactId: string): string {
    return join(this.blobRoot, artifactId.slice(0, 2), artifactId);
  }

  private readIndex(): ArtifactMetadata[] {
    if (!existsSync(this.indexFilePath)) return [];
    return JSON.parse(readFileSync(this.indexFilePath, 'utf8')) as ArtifactMetadata[];
  }

  private persist(): void {
    const temporaryPath = `${this.indexFilePath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.list(), null, 2)}\n`);
    renameSync(temporaryPath, this.indexFilePath);
  }
}

function failed(artifactId: string, reason: ArtifactVerificationFailure, detail: string): ArtifactVerification {
  return { ok: false, artifactId, reason, detail };
}

/**
 * Fail closed before evaluation or deployment: throw on the first artifact that
 * is missing, deleted, or does not match its checksum.
 */
export function assertArtifactsVerified(
  store: ArtifactStore,
  artifactIds: readonly string[]
): readonly ArtifactMetadata[] {
  return artifactIds.map((artifactId) => {
    const verification = store.verify(artifactId);
    if (!verification.ok) {
      throw new Error(`artifact ${artifactId} failed verification: ${verification.reason} (${verification.detail})`);
    }
    return verification.metadata;
  });
}
