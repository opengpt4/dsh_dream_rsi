import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  Ed25519SignatureVerifier,
  SIGNATURE_ALGORITHM,
  createPolicyArtifact,
  loadKeyRing,
  signPolicyArtifact,
  verifyPolicyArtifact
} from '../dist/index.js';

const AT = '2026-01-01T00:00:00.000Z';
const LATER = '2026-07-01T00:00:00.000Z';

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  };
}

function policy(overrides = {}) {
  return createPolicyArtifact({
    version: 'v1',
    parentVersion: null,
    source: 'export const decide = () => 1;',
    manifest: { entrypoint: 'src/policy.ts', dependencies: [], schemaVersion: 1 },
    allowedCapabilities: ['scheduling'],
    createdBy: 'human',
    createdAt: AT,
    ...overrides
  });
}

const ringOf = (...keys) => ({ keys });
const verifierAt = (ring, iso) => new Ed25519SignatureVerifier(ring, () => new Date(iso));

/** Reason the verifier gives for a refusal, or a failure if it accepted. */
function refusalReason(verifier, artifact) {
  const verdict = verifier.verify(artifact);
  assert.equal(verdict.valid, false, 'expected the verifier to refuse');
  return verdict.reason;
}

// ------------------------------------------------------------ signing itself

test('a signed artifact verifies and keeps the id it had', () => {
  const { publicKeyPem, privateKeyPem } = keyPair();
  const unsigned = policy();
  const signed = signPolicyArtifact(unsigned, { privateKeyPem, keyId: 'rotate-2026', now: () => new Date(AT) });

  // The signature is not part of the id, so signing does not re-identify the
  // artifact and a registry that already holds it keeps the same entry.
  assert.equal(signed.artifactId, unsigned.artifactId);
  assert.equal(verifyPolicyArtifact(signed), true);
  assert.deepEqual(signed.signature, {
    algorithm: SIGNATURE_ALGORITHM,
    keyId: 'rotate-2026',
    value: signed.signature.value,
    signedAt: AT
  });
  const verdict = verifierAt(ringOf({ keyId: 'rotate-2026', publicKeyPem }), LATER).verify(signed);
  assert.deepEqual(verdict, { valid: true });
});

test('a signature made over one artifact does not verify for another', () => {
  const { publicKeyPem, privateKeyPem } = keyPair();
  const signed = signPolicyArtifact(policy(), { privateKeyPem, keyId: 'k1', now: () => new Date(AT) });
  // Same key, same ring, different body: the signature is bound to the id it
  // was made over, and the other artifact's own id is self-consistent.
  const other = { ...policy({ version: 'v2', parentVersion: 'v1' }), signature: signed.signature };
  const reason = refusalReason(verifierAt(ringOf({ keyId: 'k1', publicKeyPem }), LATER), other);
  assert.match(reason, /not made for artifact/);
});

test('a tampered body is refused even though the signature is untouched', () => {
  const { publicKeyPem, privateKeyPem } = keyPair();
  const signed = signPolicyArtifact(policy(), { privateKeyPem, keyId: 'k1', now: () => new Date(AT) });
  const tampered = { ...signed, allowedCapabilities: ['scheduling', 'deployment'] };

  const reason = refusalReason(verifierAt(ringOf({ keyId: 'k1', publicKeyPem }), LATER), tampered);
  assert.match(reason, /does not match its id/);
});

test('a tampered signature is refused', () => {
  const { publicKeyPem, privateKeyPem } = keyPair();
  const signed = signPolicyArtifact(policy(), { privateKeyPem, keyId: 'k1', now: () => new Date(AT) });
  const value = signed.signature.value;
  const flipped = `${value.slice(0, -2)}${value.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
  const tampered = { ...signed, signature: { ...signed.signature, value: flipped } };

  const reason = refusalReason(verifierAt(ringOf({ keyId: 'k1', publicKeyPem }), LATER), tampered);
  assert.match(reason, /not made for artifact/);
});

test('an unsigned artifact is refused', () => {
  const { publicKeyPem } = keyPair();
  const reason = refusalReason(verifierAt(ringOf({ keyId: 'k1', publicKeyPem }), LATER), policy());
  assert.match(reason, /unsigned/);
});

// ---------------------------------------------------------------- rotation

test('rotation: a new key signs while the old key still verifies', () => {
  const oldKey = keyPair();
  const newKey = keyPair();
  const ring = ringOf(
    { keyId: 'old', publicKeyPem: oldKey.publicKeyPem, notAfter: '2026-06-30T00:00:00.000Z' },
    { keyId: 'new', publicKeyPem: newKey.publicKeyPem }
  );

  const signedByOld = signPolicyArtifact(policy(), { privateKeyPem: oldKey.privateKeyPem, keyId: 'old' });
  const signedByNew = signPolicyArtifact(policy({ version: 'v2', parentVersion: 'v1' }), {
    privateKeyPem: newKey.privateKeyPem,
    keyId: 'new'
  });

  // Both verify while the old key is inside its window, which is what makes a
  // rotation non-breaking.
  assert.deepEqual(verifierAt(ring, AT).verify(signedByOld), { valid: true });
  assert.deepEqual(verifierAt(ring, AT).verify(signedByNew), { valid: true });

  // After the window closes the old key stops being trusted, so a signature it
  // made is refused rather than accepted forever by a key nobody rotates out.
  const reason = refusalReason(verifierAt(ring, LATER), signedByOld);
  assert.match(reason, /key old expired at 2026-06-30/);
  assert.deepEqual(verifierAt(ring, LATER).verify(signedByNew), { valid: true });
});

test('a key that is not yet valid is refused', () => {
  const { publicKeyPem, privateKeyPem } = keyPair();
  const signed = signPolicyArtifact(policy(), { privateKeyPem, keyId: 'k1' });
  const ring = ringOf({ keyId: 'k1', publicKeyPem, notBefore: LATER });

  const reason = refusalReason(verifierAt(ring, AT), signed);
  assert.match(reason, /key k1 is not valid before 2026-07-01/);
});

test('a signature from a key outside the ring is refused by name', () => {
  const signer = keyPair();
  const other = keyPair();
  const signed = signPolicyArtifact(policy(), { privateKeyPem: signer.privateKeyPem, keyId: 'retired-2025' });
  const ring = ringOf({ keyId: 'rotate-2026', publicKeyPem: other.publicKeyPem });

  const reason = refusalReason(verifierAt(ring, AT), signed);
  assert.match(reason, /no key retired-2025 is in the key ring/);
});

test('a malformed validity window refuses rather than reading as unbounded', () => {
  const { publicKeyPem, privateKeyPem } = keyPair();
  const signed = signPolicyArtifact(policy(), { privateKeyPem, keyId: 'k1' });
  const ring = ringOf({ keyId: 'k1', publicKeyPem, notAfter: 'the end of June' });

  const reason = refusalReason(verifierAt(ring, AT), signed);
  assert.match(reason, /unreadable notAfter of the end of June/);
});

test('a key of the wrong type is refused by type', () => {
  const { privateKeyPem } = keyPair();
  const rsaPublic = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
  const signed = signPolicyArtifact(policy(), { privateKeyPem, keyId: 'k1' });

  const reason = refusalReason(verifierAt(ringOf({ keyId: 'k1', publicKeyPem: rsaPublic }), AT), signed);
  assert.match(reason, /is a rsa key, not ed25519/);
});

test('a key that does not parse is refused', () => {
  const { privateKeyPem } = keyPair();
  const signed = signPolicyArtifact(policy(), { privateKeyPem, keyId: 'k1' });

  const reason = refusalReason(verifierAt(ringOf({ keyId: 'k1', publicKeyPem: 'not a pem' }), AT), signed);
  assert.match(reason, /does not parse as a public key/);
});

test('an empty signature is refused', () => {
  const { publicKeyPem, privateKeyPem } = keyPair();
  const signed = signPolicyArtifact(policy(), { privateKeyPem, keyId: 'k1' });
  const emptied = { ...signed, signature: { ...signed.signature, value: '' } };

  const reason = refusalReason(verifierAt(ringOf({ keyId: 'k1', publicKeyPem }), AT), emptied);
  assert.match(reason, /signature is empty/);
});

test('an empty key ring refuses every signature', () => {
  const { privateKeyPem } = keyPair();
  const signed = signPolicyArtifact(policy(), { privateKeyPem, keyId: 'k1' });

  const reason = refusalReason(verifierAt(ringOf(), AT), signed);
  assert.match(reason, /no key k1 is in the key ring/);
});

// -------------------------------------------------------- signer refusals

test('the signer refuses an artifact whose body does not match its id', () => {
  const { privateKeyPem } = keyPair();
  const tampered = { ...policy(), version: 'v9' };

  // Signing it would publish a signature saying a tampered body is the artifact
  // it claims to be.
  assert.throws(
    () => signPolicyArtifact(tampered, { privateKeyPem, keyId: 'k1' }),
    /refusing to sign policy artifact .* body does not match its id/
  );
});

test('the signer refuses a key that is not Ed25519', () => {
  const rsaPrivate = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();

  assert.throws(
    () => signPolicyArtifact(policy(), { privateKeyPem: rsaPrivate, keyId: 'k1' }),
    /refusing to sign with a rsa key: the scheme is ed25519/
  );
});

// ------------------------------------------------------------ key ring file

test('a key ring loads from a file and a malformed one is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dream-rsi-ring-'));
  try {
    const { publicKeyPem } = keyPair();
    const path = join(dir, 'ring.json');
    writeFileSync(
      path,
      JSON.stringify({ keys: [{ keyId: 'k1', publicKeyPem, notAfter: LATER }] })
    );
    assert.deepEqual(loadKeyRing(path), { keys: [{ keyId: 'k1', publicKeyPem, notAfter: LATER }] });

    // A ring that silently lost its keys would refuse every deployment, and the
    // operator would be reading a configuration error as a signing failure.
    writeFileSync(path, JSON.stringify({ keys: {} }));
    assert.throws(() => loadKeyRing(path), /must be an object with a keys array/);

    writeFileSync(path, JSON.stringify({ keys: [{ publicKeyPem }] }));
    assert.throws(() => loadKeyRing(path), /entry 0 has no keyId/);

    // An empty id would name no key, so every signature naming it would be
    // refused as unknowable rather than as untrusted.
    writeFileSync(path, JSON.stringify({ keys: [{ keyId: '', publicKeyPem }] }));
    assert.throws(() => loadKeyRing(path), /entry 0 has no keyId/);

    writeFileSync(path, JSON.stringify({ keys: [{ keyId: 'k1' }] }));
    assert.throws(() => loadKeyRing(path), /entry k1 has no publicKeyPem/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
