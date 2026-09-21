import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Attempts before giving up on contention. A loser retries rather than forcing. */
const MAX_ACQUIRE_ATTEMPTS = 5;

export class SingleWriterLock {
  private held = false;
  private recovered = false;
  private readonly ownerId = `${process.pid}-${Math.random().toString(36).slice(2)}`;

  constructor(
    private readonly lockPath: string,
    private readonly leaseMs = 300_000
  ) {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be positive');
  }

  /** True when the most recent `acquire` took over a genuinely expired lease. */
  get recoveredStaleLock(): boolean {
    return this.recovered;
  }

  /** Identity recorded in the lease, so an audit event can name the writer. */
  get owner(): string {
    return this.ownerId;
  }

  acquire(): void {
    if (this.held) throw new Error(`lock ${this.lockPath} is already held by this instance`);
    this.recovered = false;
    mkdirSync(dirname(this.lockPath), { recursive: true });

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      if (this.create()) {
        this.writeLease();
        this.held = true;
        return;
      }
      if (!this.isExpired()) throw new Error(`lock ${this.lockPath} is already held`);
      if (this.takeOver()) {
        this.writeLease();
        this.held = true;
        return;
      }
    }
    // Every attempt lost a race. Failing is the safe outcome: the caller retries
    // rather than proceeding without a lock.
    throw new Error(`lock ${this.lockPath} could not be acquired after ${MAX_ACQUIRE_ATTEMPTS} attempts`);
  }

  heartbeat(): void {
    if (!this.held) throw new Error(`lock ${this.lockPath} is not held by this instance`);
    this.writeLease();
    const now = new Date();
    utimesSync(this.lockPath, now, now);
  }

  /**
   * Release the lock, but only if the lease still names this writer.
   *
   * A writer whose lease expired has already lost the lock to whoever took it
   * over; removing the directory then would destroy the new holder's lock.
   */
  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      const metadata = JSON.parse(readFileSync(this.metadataPath(), 'utf8')) as { ownerId?: string };
      if (metadata.ownerId !== this.ownerId) return;
    } catch {
      // The lease is gone, so there is nothing of ours left to release.
      return;
    }
    rmSync(this.lockPath, { recursive: true, force: true });
  }

  withLock<T>(operation: () => T): T {
    this.acquire();
    try {
      return operation();
    } finally {
      this.release();
    }
  }

  private metadataPath(): string {
    return `${this.lockPath}/lease.json`;
  }

  private writeLease(): void {
    writeFileSync(this.metadataPath(), JSON.stringify({ ownerId: this.ownerId, expiresAt: Date.now() + this.leaseMs }));
  }

  private create(): boolean {
    try {
      mkdirSync(this.lockPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  /**
   * Move a stale lock aside, then create a fresh one.
   *
   * Rename is atomic, so at most one racer can move a given directory: the loser
   * gets ENOENT and retries instead of removing a lock its winner just created.
   * Remove-then-create had a window in which both racers held the lock.
   */
  private takeOver(): boolean {
    const stale = `${this.lockPath}.stale-${this.ownerId}`;
    try {
      renameSync(this.lockPath, stale);
    } catch {
      // Another racer moved it first, or it is already gone.
      return false;
    }
    rmSync(stale, { recursive: true, force: true });
    if (!this.create()) return false;
    this.recovered = true;
    return true;
  }

  private isExpired(): boolean {
    try {
      const metadata = JSON.parse(readFileSync(this.metadataPath(), 'utf8')) as { expiresAt?: unknown };
      return typeof metadata.expiresAt !== 'number' || metadata.expiresAt <= Date.now();
    } catch {
      // No readable lease. A live lock passes through exactly this state between
      // creating its directory and writing the lease, so treat a young
      // directory as live; only one older than a whole lease can belong to a
      // writer that died in that window.
      return this.directoryAgeMs() >= this.leaseMs;
    }
  }

  private directoryAgeMs(): number {
    try {
      return Date.now() - statSync(this.lockPath).mtimeMs;
    } catch {
      // Not there any more, so there is nothing live to protect.
      return Number.POSITIVE_INFINITY;
    }
  }
}
