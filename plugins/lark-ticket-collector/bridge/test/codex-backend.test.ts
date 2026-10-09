import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_OUTPUT_SCHEMA,
  buildCodexRuntimeProbeArgs,
  buildCodexArgs,
  isCodexRuntimeCompatibilityFailure,
  parseCodexRuntimeProbeOutput,
  parseAgentOutput,
  resolveExecutablePath,
} from "../src/codex-backend.js";
import type { BridgeConfig } from "../src/config.js";
import type { AgentRequest } from "../src/types.js";

const config: BridgeConfig = {
  lark: {
    appId: "cli_test",
    appSecret: "secret",
    cliBin: "lark-cli",
    allowedChatIds: [],
    visitRecordChatIds: [],
    visitRecordAllGroups: false,
    allowedSenderIds: [],
    requireMention: true,
  },
  meegleIdentity: {
    enabled: false,
    bin: "meegle",
    host: "project.feishu.cn",
    projectKey: "v2qint",
    profileOverrides: new Map(),
  },
  codex: {
    bin: "codex",
    workspace: "/tmp/workspace",
    timeoutMs: 180_000,
    probeTimeoutMs: 30_000,
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

test("Codex startup probe uses structured output without ticket resources", () => {
  const args = buildCodexRuntimeProbeArgs({
    config,
    outputPath: "/tmp/probe.json",
    schemaPath: "/tmp/probe.schema.json",
  });

  assert.deepEqual(
    args.slice(args.indexOf("--output-schema"), args.indexOf("--output-schema") + 2),
    ["--output-schema", "/tmp/probe.schema.json"],
  );
  assert.ok(args.includes("--ephemeral"));
  assert.ok(!args.includes("--add-dir"));
  assert.ok(!args.includes("--image"));
  assert.deepEqual(parseCodexRuntimeProbeOutput('{"status":"READY"}'), {
    status: "READY",
  });
  assert.throws(() => parseCodexRuntimeProbeOutput('{"status":"NO"}'));
});

test("Codex configuration schema failures are classified before ticket execution", () => {
  assert.equal(
    isCodexRuntimeCompatibilityFailure(
      "field `supports_parallel_tool_calls` at line 130 column 5",
    ),
    true,
  );
  assert.equal(
    isCodexRuntimeCompatibilityFailure("network connection closed after tool execution"),
    false,
  );
});

test("verified Meegle identity is pinned into Codex command environment", () => {
  const args = buildCodexArgs({
    config: {
      ...config,
      meegleIdentity: { ...config.meegleIdentity, bin: "/opt/bin/meegle-real" },
    },
    request: {
      ...request,
      envelope: {
        ...request.envelope,
        meegleIdentity: {
          profile: "lark-yvonne",
          userKey: "user_yvonne",
          name: "Yvonne",
        },
      },
    },
    outputPath: "/tmp/output.md",
    schemaPath: "/tmp/output.schema.json",
    meegleWrapperDirectory: "/srv/bridge/bin",
  });

  const overrides = args
    .map((value, index) => (value === "-c" ? args[index + 1] : undefined))
    .filter((value): value is string => Boolean(value));
  assert.ok(overrides.includes("features.shell_snapshot=false"));
  assert.ok(
    overrides.includes(
      `shell_environment_policy.set.MEEGLE_REQUEST_PROFILE=${JSON.stringify("lark-yvonne")}`,
    ),
  );
  assert.ok(
    overrides.includes(
      `shell_environment_policy.set.MEEGLE_REAL_BIN=${JSON.stringify("/opt/bin/meegle-real")}`,
    ),
  );
  assert.ok(
    overrides.some(
      (value) =>
        value.startsWith("shell_environment_policy.set.PATH=") &&
        value.includes("/srv/bridge/bin:"),
    ),
  );
});

test("Meegle real binary is resolved before the wrapper PATH is injected", () => {
  assert.equal(
    resolveExecutablePath(
      "meegle",
      "/missing:/opt/ticket/bin:/usr/local/bin",
      (candidate) => candidate === "/opt/ticket/bin/meegle",
    ),
    "/opt/ticket/bin/meegle",
  );
});

test("agent output schema requires a user reply and structured draft state", () => {
  assert.deepEqual(AGENT_OUTPUT_SCHEMA.required, [
    "reply",
    "draft",
    "attachment_archive",
  ]);
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
        attachment_archive: {
          status: "not_applicable",
          expected_bindings: 0,
          verified_bindings: 0,
          targets: [],
          note: null,
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
      attachmentArchive: {
        status: "not_applicable",
        expectedBindings: 0,
        verifiedBindings: 0,
        targets: [],
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
