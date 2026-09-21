import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { SignatureVerifier, SignatureVerdict } from './deployment-writer.js';
import {
  SIGNATURE_ALGORITHM,
  verifyPolicyArtifact,
  type ArtifactSignature,
  type PolicyArtifact
} from './models.js';

/**
 * Ed25519 detached signatures over artifact ids, with public keys in a PEM key
 * ring.
 *
 * The signed value is the record id, which is the hash of the record's own
 * body. Signing the id rather than the body keeps one signature valid for every
 * encoding of the body and makes the covered fields explicit: the fields that
 * are deliberately not identity — `createdAt`, `sourceRef`, and the signature
 * itself — are outside it. A verifier therefore recomputes the body hash first,
 * so a swapped body cannot ride a signature made for the id it now claims.
 *
 * The key ring is the rotation mechanism. A signature names its `keyId`, and
 * each entry carries an optional validity window, so a new key can be added
 * while old signatures still verify, and retiring a key is a `notAfter` rather
 * than a deletion that would invalidate the audit trail behind it. Every
 * refusal names its reason, because "expired key" and "unknown key" call for
 * different operator action.
 */

export interface KeyRingEntry {
  readonly keyId: string;
  /** SPKI PEM public key, the form `openssl pkey -pubout` writes. */
  readonly publicKeyPem: string;
  /** ISO-8601 inclusive bounds. An omitted bound is open. */
  readonly notBefore?: string;
  readonly notAfter?: string;
}

export interface KeyRing {
  readonly keys: readonly KeyRingEntry[];
}

export interface SignPolicyArtifactInput {
  /** PKCS#8 PEM private key. */
  readonly privateKeyPem: string;
  readonly keyId: string;
  readonly now?: () => Date;
}

/**
 * Read a key ring from a JSON document of the form
 * `{ "keys": [{ "keyId": "...", "publicKeyPem": "-----BEGIN PUBLIC KEY..." }] }`.
 *
 * A malformed ring throws rather than yielding an empty one: a ring that
 * silently lost its keys would refuse every deployment, and the operator would
 * be reading a configuration error as a signing failure.
 */
export function loadKeyRing(path: string): KeyRing {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as KeyRing).keys)) {
    throw new Error(`key ring ${path} must be an object with a keys array`);
  }
  const keys = (parsed as KeyRing).keys.map((entry, index) => {
    const { keyId, publicKeyPem, notBefore, notAfter } = (entry ?? {}) as Partial<KeyRingEntry>;
    if (typeof keyId !== 'string' || keyId.length === 0) {
      throw new Error(`key ring ${path} entry ${index} has no keyId`);
    }
    if (typeof publicKeyPem !== 'string' || publicKeyPem.length === 0) {
      throw new Error(`key ring ${path} entry ${keyId} has no publicKeyPem`);
    }
    return {
      keyId,
      publicKeyPem,
      ...(notBefore !== undefined ? { notBefore } : {}),
      ...(notAfter !== undefined ? { notAfter } : {})
    };
  });
  return { keys };
}

/**
 * Attach a detached signature over the artifact's id.
 *
 * Refuses an artifact whose body does not hash to its id: signing it would
 * publish a signature that says a tampered body is the artifact it claims to
 * be. The returned artifact has the same id, because the signature is not part
 * of it.
 */
export function signPolicyArtifact(artifact: PolicyArtifact, input: SignPolicyArtifactInput): PolicyArtifact {
  if (!verifyPolicyArtifact(artifact)) {
    throw new Error(`refusing to sign policy artifact ${artifact.artifactId}: its body does not match its id`);
  }
  const key = createPrivateKey(input.privateKeyPem);
  if (key.asymmetricKeyType !== SIGNATURE_ALGORITHM) {
    throw new Error(`refusing to sign with a ${key.asymmetricKeyType ?? 'unknown'} key: the scheme is ${SIGNATURE_ALGORITHM}`);
  }
  const signature: ArtifactSignature = {
    algorithm: SIGNATURE_ALGORITHM,
    keyId: input.keyId,
    value: sign(null, Buffer.from(artifact.artifactId, 'utf8'), key).toString('base64'),
    signedAt: (input.now?.() ?? new Date()).toISOString()
  };
  return { ...artifact, signature };
}

export class Ed25519SignatureVerifier implements SignatureVerifier {
  private readonly now: () => Date;

  constructor(private readonly ring: KeyRing, now?: () => Date) {
    this.now = now ?? (() => new Date());
  }

  verify(artifact: PolicyArtifact): SignatureVerdict {
    // Before the signature: the signature covers the id, so a body that no
    // longer hashes to it is not the artifact anything was signed about.
    if (!verifyPolicyArtifact(artifact)) return refuse('its body does not match its id');

    const signature = artifact.signature;
    if (signature === undefined) return refuse('it is unsigned');
    if (signature.algorithm !== SIGNATURE_ALGORITHM) {
      return refuse(`its signature algorithm ${signature.algorithm} is not ${SIGNATURE_ALGORITHM}`);
    }

    const entry = this.ring.keys.find((key) => key.keyId === signature.keyId);
    if (entry === undefined) return refuse(`no key ${signature.keyId} is in the key ring`);

    const window = validityRefusal(entry, this.now());
    if (window !== undefined) return refuse(`key ${entry.keyId} ${window}`);

    const publicKey = publicKeyOf(entry);
    if (!publicKey.ok) return refuse(`key ${entry.keyId} ${publicKey.reason}`);

    const signatureBytes = Buffer.from(signature.value, 'base64');
    if (signatureBytes.length === 0) return refuse('its signature is empty');
    if (!verify(null, Buffer.from(artifact.artifactId, 'utf8'), publicKey.key, signatureBytes)) {
      return refuse(`its signature was not made for artifact ${artifact.artifactId}`);
    }
    return { valid: true };
  }
}

function refuse(reason: string): SignatureVerdict {
  return { valid: false, reason };
}

/** Why the entry may not sign right now, or `undefined` when it may. */
function validityRefusal(entry: KeyRingEntry, now: Date): string | undefined {
  for (const [bound, value] of [
    ['notBefore', entry.notBefore],
    ['notAfter', entry.notAfter]
  ] as const) {
    if (value === undefined) continue;
    const limit = new Date(value);
    // An unreadable window is a refusal: a typo in a date must not read as an
    // unbounded key.
    if (Number.isNaN(limit.getTime())) return `has an unreadable ${bound} of ${value}`;
  }
  if (entry.notBefore !== undefined && now.getTime() < new Date(entry.notBefore).getTime()) {
    return `is not valid before ${entry.notBefore}`;
  }
  if (entry.notAfter !== undefined && now.getTime() > new Date(entry.notAfter).getTime()) {
    return `expired at ${entry.notAfter}`;
  }
  return undefined;
}

/** The parsed key, or the reason the entry cannot be used. */
function publicKeyOf(entry: KeyRingEntry): { readonly ok: true; readonly key: KeyObject } | { readonly ok: false; readonly reason: string } {
  let key: KeyObject;
  try {
    key = createPublicKey(entry.publicKeyPem);
  } catch {
    return { ok: false, reason: 'does not parse as a public key' };
  }
  if (key.asymmetricKeyType !== SIGNATURE_ALGORITHM) {
    return { ok: false, reason: `is a ${key.asymmetricKeyType ?? 'unknown'} key, not ${SIGNATURE_ALGORITHM}` };
  }
  return { ok: true, key };
}
