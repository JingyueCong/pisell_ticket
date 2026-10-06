import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BridgeConfig } from "../src/config.js";
import {
  extractMinuteLinks,
  isAutomaticVisitRecordMessage,
  VisitRecordLoader,
  type VisitRecordProcessRunner,
} from "../src/visit-record.js";

function config(resourceDir: string): BridgeConfig {
  return {
    lark: {
      appId: "cli_test",
      appSecret: "secret",
      cliProfile: "ticket-collector",
      cliBin: "/opt/bin/lark-cli",
      allowedChatIds: [],
      visitRecordChatIds: ["oc_customer"],
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
    },
    storage: {
      dataDir: join(resourceDir, ".."),
      dbPath: join(resourceDir, "..", "bridge.sqlite"),
      resourceDir,
    },
    limits: {
      maxReplyChars: 12_000,
      maxHistoryMessages: 12,
      maxHistoryAgeMs: 30 * 24 * 60 * 60_000,
      draftTtlMs: 7 * 24 * 60 * 60_000,
      maxResourceBytes: 25 * 1024 * 1024,
    },
    health: { host: "127.0.0.1", port: 0 },
  };
}

test("extractMinuteLinks finds and deduplicates Feishu Minutes links", () => {
  assert.deepEqual(
    extractMinuteLinks(
      "会议纪要 https://m1ed09stz4r.feishu.cn/minutes/OBCNU123abc。再次：" +
        "https://m1ed09stz4r.feishu.cn/minutes/obcnu123abc",
    ),
    [
      {
        token: "obcnu123abc",
        url: "https://m1ed09stz4r.feishu.cn/minutes/OBCNU123abc",
      },
    ],
  );
});

test("automatic visit-record trigger requires a configured group and a Minutes link", () => {
  assert.equal(
    isAutomaticVisitRecordMessage({
      chatId: "oc_customer",
      chatType: "group",
      content: "https://tenant.feishu.cn/minutes/obcnu123",
      visitRecordChatIds: ["oc_customer"],
    }),
    true,
  );
  assert.equal(
    isAutomaticVisitRecordMessage({
      chatId: "oc_other",
      chatType: "group",
      content: "https://tenant.feishu.cn/minutes/obcnu123",
      visitRecordChatIds: ["oc_customer"],
    }),
    false,
  );
  assert.equal(
    isAutomaticVisitRecordMessage({
      chatId: "oc_customer",
      chatType: "group",
      content: "普通消息",
      visitRecordChatIds: ["oc_customer"],
    }),
    false,
  );
});

test("automatic visit-record trigger accepts any bot group when enabled", () => {
  assert.equal(
    isAutomaticVisitRecordMessage({
      chatId: "oc_new_customer",
      chatType: "group",
      content:
        '{"card":{"url":"https://tenant.feishu.cn/minutes/obcnu456"}}',
      visitRecordChatIds: [],
      visitRecordAllGroups: true,
    }),
    true,
  );
  assert.equal(
    isAutomaticVisitRecordMessage({
      chatId: "oc_new_customer",
      chatType: "group",
      content: "普通群消息",
      visitRecordChatIds: [],
      visitRecordAllGroups: true,
    }),
    false,
  );
});

test("VisitRecordLoader preserves smart artifacts and a sandboxed transcript path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-visit-record-"));
  const resourceDir = join(directory, "resources");
  const calls: Array<{ executable: string; args: string[]; cwd: string }> = [];
  const runner: VisitRecordProcessRunner = async (input) => {
    calls.push(input);
    writeFileSync(join(input.cwd, "transcript.txt"), "Speaker 1: POS 经常卡慢");
    return {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        ok: true,
        data: {
          minutes: [
            {
              title: "门店现场沟通",
              artifacts: {
                summary: "讨论 POS 卡慢与菜单调整。",
                keywords: ["POS", "菜单"],
                chapters: [
                  {
                    title: "POS 问题",
                    start_ms: "1000",
                    stop_ms: "2000",
                    summary_content: "付款时偶发卡慢",
                  },
                ],
                todos: [
                  {
                    content: "Yvonne 跟进日志",
                    assignees: ["Yvonne"],
                    is_done: false,
                  },
                ],
                transcript_file: "transcript.txt",
              },
            },
          ],
        },
      }),
    };
  };

  try {
    const record = await new VisitRecordLoader(config(resourceDir), runner).load({
      messageId: "om_1",
      sourceChatId: "oc_customer",
      sourceChatName: "Little Amigos Highpoint 客户群",
      link: {
        token: "obcnu123",
        url: "https://tenant.feishu.cn/minutes/obcnu123",
      },
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args.slice(0, 5), [
      "--profile",
      "ticket-collector",
      "minutes",
      "+detail",
      "--as",
    ]);
    assert.equal(record.title, "门店现场沟通");
    assert.equal(record.summary, "讨论 POS 卡慢与菜单调整。");
    assert.deepEqual(record.keywords, ["POS", "菜单"]);
    assert.deepEqual(record.chapters, [
      {
        title: "POS 问题",
        startMs: "1000",
        stopMs: "2000",
        summary: "付款时偶发卡慢",
      },
    ]);
    assert.deepEqual(record.todos, [
      { content: "Yvonne 跟进日志", assignees: ["Yvonne"], isDone: false },
    ]);
    assert.match(record.transcriptPath ?? "", /transcript\.txt$/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
