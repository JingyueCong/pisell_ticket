import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_OUTPUT_SCHEMA,
  buildCodexArgs,
  parseAgentOutput,
} from "../src/codex-backend.js";
import type { BridgeConfig } from "../src/config.js";
import type { AgentRequest } from "../src/types.js";

const config: BridgeConfig = {
  lark: {
    appId: "cli_test",
    appSecret: "secret",
    cliBin: "lark-cli",
    allowedChatIds: [],
    allowedSenderIds: [],
    requireMention: true,
  },
  meegleIdentity: {
    enabled: false,
    bin: "meegle",
    host: "project.feishu.cn",
    profileOverrides: new Map(),
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
    maxHistoryMessages: 12,
    maxHistoryAgeMs: 30 * 24 * 60 * 60_000,
    draftTtlMs: 7 * 24 * 60 * 60_000,
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
  const args = buildCodexArgs({
    config,
    request,
    outputPath: "/tmp/output.md",
    schemaPath: "/tmp/output.schema.json",
  });

  assert.ok(args.includes("--approve-for-me"));
  assert.deepEqual(
    args.slice(args.indexOf("--output-schema"), args.indexOf("--output-schema") + 2),
    ["--output-schema", "/tmp/output.schema.json"],
  );
  assert.ok(!args.includes("--sandbox"));
  assert.ok(!args.includes("-s"));
});

test("agent output schema requires a user reply and structured draft state", () => {
  assert.deepEqual(AGENT_OUTPUT_SCHEMA.required, ["reply", "draft"]);
  assert.deepEqual(AGENT_OUTPUT_SCHEMA.properties.draft.properties.action.enum, [
    "none",
    "open",
    "update",
    "close",
  ]);
});

test("structured agent output separates the employee reply from draft memory", () => {
  assert.deepEqual(
    parseAgentOutput(
      JSON.stringify({
        reply: "请补充店铺",
        draft: {
          action: "open",
          ticket_type: "内容维护",
          summary: "菜单调整，等待店铺",
          missing_fields: ["关联客户 / 店铺"],
          work_item_ids: [],
        },
      }),
    ),
    {
      text: "请补充店铺",
      draft: {
        action: "open",
        ticketType: "内容维护",
        summary: "菜单调整，等待店铺",
        missingFields: ["关联客户 / 店铺"],
        workItemIds: [],
      },
    },
  );
  assert.throws(() => parseAgentOutput("not-json"));
});

test("Codex CLI reattaches images preserved by an active draft", () => {
  const args = buildCodexArgs({
    config,
    request: {
      ...request,
      activeDraft: {
        id: "draft_1",
        conversationKey: "oc_1:ou_1:scope:om_0",
        chatId: "oc_1",
        senderId: "ou_1",
        summary: "等待补充",
        missingFields: ["任务描述"],
        workItemIds: [],
        resources: [
          {
            type: "image",
            fileKey: "img_1",
            localPath: "/tmp/resources/original.png",
          },
        ],
        updatedAt: 1,
        expiresAt: 2,
      },
    },
    outputPath: "/tmp/output.md",
    schemaPath: "/tmp/output.schema.json",
  });

  assert.deepEqual(args.slice(args.indexOf("--image"), args.indexOf("--image") + 2), [
    "--image",
    "/tmp/resources/original.png",
  ]);
});
