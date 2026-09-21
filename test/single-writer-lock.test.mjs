import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SingleWriterLock } from '../dist/index.js';

/**
 * Lease recovery.
 *
 * A lock directory exists before its lease file does, so "no lease" is a state a
 * live lock passes through. Treating it as expiry let a second acquirer take
 * over a lock that was never stale -- and report it as an audited recovery.
 */

function withLockDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lock-'));
  try {
    return run(join(dir, 'writer.lock'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ageLock(lockPath, ms) {
  const past = new Date(Date.now() - ms);
  utimesSync(lockPath, past, past);
}

test('a lock created but not yet leased is live, not stale', () => {
  withLockDir((lockPath) => {
    // Exactly the state a live acquirer is in between mkdir and the lease write.
    mkdirSync(lockPath);

    const second = new SingleWriterLock(lockPath, 30_000);
    assert.throws(() => second.acquire(), /is already held/);
    // And it must not claim a recovery that never happened.
    assert.equal(second.recoveredStaleLock, false);
  });
});

test('a lease-less lock old enough to be a dead writer is taken over', () => {
  withLockDir((lockPath) => {
    // A writer that died between creating the directory and writing its lease
    // leaves exactly this, and it must not block the lock forever.
    mkdirSync(lockPath);
    ageLock(lockPath, 60_000);

    const taker = new SingleWriterLock(lockPath, 30_000);
    taker.acquire();

    assert.equal(taker.recoveredStaleLock, true);
    assert.equal(existsSync(join(lockPath, 'lease.json')), true);
    taker.release();
  });
});

test('an expired lease is taken over and reported', () => {
  withLockDir((lockPath) => {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'lease.json'), JSON.stringify({ ownerId: 'crashed', expiresAt: Date.now() - 1_000 }));

    const taker = new SingleWriterLock(lockPath, 30_000);
    taker.acquire();

    assert.equal(taker.recoveredStaleLock, true);
    const lease = JSON.parse(readFileSync(join(lockPath, 'lease.json'), 'utf8'));
    assert.equal(lease.ownerId, taker.owner);
    assert.ok(lease.expiresAt > Date.now());
    taker.release();
  });
});

test('a live lease is not taken over however old the directory looks', () => {
  withLockDir((lockPath) => {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'lease.json'), JSON.stringify({ ownerId: 'alive', expiresAt: Date.now() + 60_000 }));
    // The directory's age is irrelevant while a live lease exists.
    ageLock(lockPath, 600_000);

    assert.throws(() => new SingleWriterLock(lockPath, 30_000).acquire(), /is already held/);
  });
});

test('a writer that lost its lease does not release the new holder', () => {
  withLockDir((lockPath) => {
    const original = new SingleWriterLock(lockPath, 1);
    original.acquire();

    // Let the lease expire, then let another writer take over.
    const expiry = Date.now() + 20;
    while (Date.now() < expiry) { /* spin briefly */ }
    const taker = new SingleWriterLock(lockPath, 30_000);
    taker.acquire();
    assert.equal(taker.recoveredStaleLock, true);

    // The original still thinks it holds the lock. Releasing must not destroy
    // the taker's lock.
    original.release();
    assert.equal(existsSync(lockPath), true);
    assert.equal(JSON.parse(readFileSync(join(lockPath, 'lease.json'), 'utf8')).ownerId, taker.owner);

    taker.release();
    assert.equal(existsSync(lockPath), false);
  });
});

test('release is safe when the lock directory has already gone', () => {
  withLockDir((lockPath) => {
    const lock = new SingleWriterLock(lockPath, 30_000);
    lock.acquire();
    rmSync(lockPath, { recursive: true, force: true });

    // Removing a directory that is already gone used to throw.
    assert.doesNotThrow(() => lock.release());
  });
});

test('a second acquire on one instance is refused', () => {
  withLockDir((lockPath) => {
    const lock = new SingleWriterLock(lockPath, 30_000);
    lock.acquire();
    assert.throws(() => lock.acquire(), /already held by this instance/);
    lock.release();
  });
});

test('takeover leaves no renamed-aside directory behind', () => {
  withLockDir((lockPath) => {
    mkdirSync(lockPath);
    writeFileSync(join(lockPath, 'lease.json'), JSON.stringify({ ownerId: 'crashed', expiresAt: Date.now() - 1_000 }));

    const taker = new SingleWriterLock(lockPath, 30_000);
    taker.acquire();

    // The stale lock is renamed aside to make the takeover atomic; the renamed
    // copy is removed rather than accumulating next to the live lock.
    const siblings = readdirSync(join(lockPath, '..')).filter((name) => name.includes('.stale-'));
    assert.deepEqual(siblings, []);
    taker.release();
  });
});
