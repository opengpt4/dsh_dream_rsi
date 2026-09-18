import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createEvaluationSnapshot } from '../dist/evolution/snapshot.js';
import { SingleWriterLock } from '../dist/operations/single-writer-lock.js';

const node = {
  nodeId: 'snapshot-node',
  taskId: 'task-snapshot',
  parentId: null,
  policyVersion: 'policy-1',
  environmentVersion: 'mock-room-v1',
  stateHash: 'state-1',
  observationHash: 'observation-1',
  actionType: 'observe',
  actionParams: { sensor: 'rgb' },
  result: { success: true },
  score: 0.8,
  tokenCost: 1,
  execTimeMs: 1,
  idempotencyKey: 'snapshot-action-1'
};

test('evaluation snapshot is immutable and content-addressed', () => {
  const snapshot = createEvaluationSnapshot([node], undefined, '2026-09-18T00:00:00.000Z');
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.snapshotId.length, 64);
  assert.throws(() => {
    snapshot.splits.train[0].score = 0;
  }, TypeError);
});

test('single writer lock prevents concurrent ownership and releases safely', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dream-rsi-lock-'));
  const lockPath = join(directory, 'evolution.lock');
  const first = new SingleWriterLock(lockPath);
  const second = new SingleWriterLock(lockPath);

  first.acquire();
  assert.throws(() => second.acquire(), /already held/);
  first.release();
  assert.doesNotThrow(() => second.withLock(() => 'completed'));
});

test('single writer lock recovers an expired lease', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dream-rsi-expired-lock-'));
  const lockPath = join(directory, 'evolution.lock');
  const first = new SingleWriterLock(lockPath, 300_000);
  const second = new SingleWriterLock(lockPath, 300_000);

  first.acquire();
  writeFileSync(join(lockPath, 'lease.json'), JSON.stringify({ expiresAt: Date.now() - 600_000 }));
  assert.doesNotThrow(() => second.acquire());
  second.release();
});

test('heartbeat requires ownership and refreshes a held lease', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dream-rsi-heartbeat-'));
  const lockPath = join(directory, 'evolution.lock');
  const lock = new SingleWriterLock(lockPath, 300_000);

  assert.throws(() => lock.heartbeat(), /not held/);
  lock.acquire();
  assert.doesNotThrow(() => lock.heartbeat());
  lock.release();
});