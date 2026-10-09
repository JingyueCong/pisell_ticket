import assert from "node:assert/strict";
import test from "node:test";

import { ConcurrencyLimiter } from "../src/concurrency-limiter.js";

test("ConcurrencyLimiter enforces a global cap and FIFO admission", async () => {
  const limiter = new ConcurrencyLimiter(2);
  const started: number[] = [];
  const releases: Array<() => void> = [];
  let peak = 0;

  const tasks = [0, 1, 2, 3].map((id) =>
    limiter.run(async () => {
      started.push(id);
      peak = Math.max(peak, limiter.active);
      await new Promise<void>((resolve) => releases.push(resolve));
      return id;
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1]);
  assert.equal(limiter.pending, 2);
  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2]);
  releases.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1, 2, 3]);
  while (releases.length) releases.shift()?.();
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3]);
  assert.equal(peak, 2);
  assert.equal(limiter.idle, true);
});
