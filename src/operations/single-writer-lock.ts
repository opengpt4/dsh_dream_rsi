import { mkdirSync, rmSync } from 'node:fs';

export class SingleWriterLock {
  private held = false;

  constructor(private readonly lockPath: string) {}

  acquire(): void {
    if (this.held) throw new Error(`lock ${this.lockPath} is already held by this instance`);
    try {
      mkdirSync(this.lockPath);
    } catch (error) {
      const code = error as NodeJS.ErrnoException;
      if (code.code === 'EEXIST') throw new Error(`lock ${this.lockPath} is already held`);
      throw error;
    }
    this.held = true;
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
}