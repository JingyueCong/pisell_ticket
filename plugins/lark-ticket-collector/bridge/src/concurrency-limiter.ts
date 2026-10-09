export class ConcurrencyLimiter {
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Concurrency limit must be a positive integer");
    }
  }

  get active(): number {
    return this.activeCount;
  }

  get pending(): number {
    return this.waiters.length;
  }

  get idle(): boolean {
    return this.activeCount === 0 && this.waiters.length === 0;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.activeCount += 1;
    try {
      return await task();
    } finally {
      this.activeCount -= 1;
      this.waiters.shift()?.();
    }
  }
}
