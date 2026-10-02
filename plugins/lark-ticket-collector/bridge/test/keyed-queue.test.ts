import assert from "node:assert/strict";
import test from "node:test";

import { KeyedQueue } from "../src/keyed-queue.js";

test("KeyedQueue serializes tasks with the same key", async () => {
  const queue = new KeyedQueue();
  const events: string[] = [];
  const first = queue.enqueue("same", async () => {
    events.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 15));
    events.push("first:end");
  });
  const second = queue.enqueue("same", async () => {
    events.push("second:start");
    events.push("second:end");
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});
