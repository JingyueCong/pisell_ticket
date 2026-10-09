export type RuntimeMonitorState = "healthy" | "unhealthy";

export class RuntimeMonitor {
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private failures = 0;
  private state: RuntimeMonitorState = "healthy";

  constructor(
    private readonly input: {
      intervalMs: number;
      failureThreshold: number;
      probe: () => Promise<void>;
      shouldProbe?: () => boolean;
      onTransition: (state: RuntimeMonitorState, error?: unknown) => void | Promise<void>;
      onCheck?: (result: "passed" | "failed" | "skipped", detail?: unknown) => void;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.input.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async check(): Promise<void> {
    if (this.inFlight || this.input.shouldProbe?.() === false) {
      this.input.onCheck?.("skipped");
      return;
    }
    this.inFlight = true;
    try {
      await this.input.probe();
      this.failures = 0;
      this.input.onCheck?.("passed");
      if (this.state === "unhealthy") {
        this.state = "healthy";
        await this.input.onTransition("healthy");
      }
    } catch (error) {
      this.failures += 1;
      this.input.onCheck?.("failed", error);
      if (this.failures >= this.input.failureThreshold && this.state === "healthy") {
        this.state = "unhealthy";
        await this.input.onTransition("unhealthy", error);
      }
    } finally {
      this.inFlight = false;
    }
  }
}
