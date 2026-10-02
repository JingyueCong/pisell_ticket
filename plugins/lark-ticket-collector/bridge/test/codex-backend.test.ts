import assert from "node:assert/strict";
import test from "node:test";

import { buildCodexArgs } from "../src/codex-backend.js";
import type { BridgeConfig } from "../src/config.js";
import type { AgentRequest } from "../src/types.js";

const config: BridgeConfig = {
  lark: {
    appId: "cli_test",
    appSecret: "secret",
    allowedChatIds: [],
    allowedSenderIds: [],
    requireMention: true,
  },
  codex: {
    bin: "codex",
    workspace: "/tmp/workspace",
    timeoutMs: 180_000,
  },
  storage: {
    dataDir: "/tmp/data",
    dbPath: "/tmp/data/bridge.sqlite",
    resourceDir: "/tmp/resources",
  },
  limits: {
    maxReplyChars: 12_000,
    maxHistoryMessages: 20,
    maxResourceBytes: 25 * 1024 * 1024,
  },
  health: { host: "127.0.0.1", port: 8787 },
};

const request: AgentRequest = {
  resourceRoot: "/tmp/resources",
  history: [],
  envelope: {
    messageId: "om_1",
    chatId: "oc_1",
    chatType: "group",
    senderId: "ou_1",
    content: "只预览",
    rawContentType: "text",
    createTime: 1,
    resources: [],
  },
};

test("Codex CLI args use automatic approval without a conflicting sandbox flag", () => {
  const args = buildCodexArgs({ config, request, outputPath: "/tmp/output.md" });

  assert.ok(args.includes("--approve-for-me"));
  assert.ok(!args.includes("--sandbox"));
  assert.ok(!args.includes("-s"));
});
