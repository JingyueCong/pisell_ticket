import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeMonitor, type RuntimeMonitorState } from "../src/runtime-monitor.js";

test("RuntimeMonitor downgrades after the threshold and recovers after one success", async () => {
  let shouldFail = true;
  const transitions: RuntimeMonitorState[] = [];
  const monitor = new RuntimeMonitor({
    intervalMs: 60_000,
    failureThreshold: 2,
    probe: async () => {
      if (shouldFail) throw new Error("probe failed");
    },
    onTransition: (state) => {
      transitions.push(state);
    },
  });
  await monitor.check();
  assert.deepEqual(transitions, []);
  await monitor.check();
  assert.deepEqual(transitions, ["unhealthy"]);
  await monitor.check();
  assert.deepEqual(transitions, ["unhealthy"]);
  shouldFail = false;
  await monitor.check();
  assert.deepEqual(transitions, ["unhealthy", "healthy"]);
});

test("RuntimeMonitor skips a probe while business work is active", async () => {
  let calls = 0;
  const checks: string[] = [];
  const monitor = new RuntimeMonitor({
    intervalMs: 60_000,
    failureThreshold: 2,
    shouldProbe: () => false,
    probe: async () => {
      calls += 1;
    },
    onTransition: () => undefined,
    onCheck: (result) => checks.push(result),
  });
  await monitor.check();
  assert.equal(calls, 0);
  assert.deepEqual(checks, ["skipped"]);
});
