import assert from "node:assert/strict";
import test from "node:test";

import { AgentBackendError, buildAgentFailureReply } from "../src/agent-failure.js";

test("known pre-execution failures explicitly confirm no Meegle write", () => {
  const reply = buildAgentFailureReply(
    "om_runtime",
    new AgentBackendError("runtime mismatch", "codex_runtime_incompatible", "none"),
  );

  assert.match(reply, /未对 Meegle 进行外部写入/);
  assert.match(reply, /om_runtime/);
  assert.doesNotMatch(reply, /无法确认是否已经发生外部写入/);
});

test("uncertain failures retain the duplicate-prevention warning", () => {
  const reply = buildAgentFailureReply("om_unknown", new Error("timeout"));

  assert.match(reply, /无法确认是否已经发生外部写入/);
  assert.match(reply, /不会自动重试/);
});
