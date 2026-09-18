import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';

export class SingleWriterLock {
  private held = false;
  private readonly ownerId = `${process.pid}-${Math.random().toString(36).slice(2)}`;

  constructor(
    private readonly lockPath: string,
    private readonly leaseMs = 300_000
  ) {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be positive');
  }

  acquire(): void {
    if (this.held) throw new Error(`lock ${this.lockPath} is already held by this instance`);
    try {
      mkdirSync(this.lockPath);
    } catch (error) {
      const code = error as NodeJS.ErrnoException;
      if (code.code === 'EEXIST') {
        if (this.isExpired()) {
          rmSync(this.lockPath, { recursive: true, force: true });
          mkdirSync(this.lockPath);
        } else {
          throw new Error(`lock ${this.lockPath} is already held`);
        }
      } else {
        throw error;
      }
    }
    writeFileSync(this.metadataPath(), JSON.stringify({ ownerId: this.ownerId, expiresAt: Date.now() + this.leaseMs }));
    this.held = true;
  }

  heartbeat(): void {
    if (!this.held) throw new Error(`lock ${this.lockPath} is not held by this instance`);
    writeFileSync(this.metadataPath(), JSON.stringify({ ownerId: this.ownerId, expiresAt: Date.now() + this.leaseMs }));
    const now = new Date();
    utimesSync(this.lockPath, now, now);
  }

  release(): void {
    if (!this.held) return;
    rmSync(this.lockPath, { recursive: true, force: false });
    this.held = false;
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

  private isExpired(): boolean {
    try {
      const metadata = JSON.parse(readFileSync(this.metadataPath(), 'utf8')) as { expiresAt?: unknown };
      return typeof metadata.expiresAt !== 'number' || metadata.expiresAt <= Date.now();
    } catch {
      return true;
    }
  }
}