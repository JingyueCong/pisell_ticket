import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { BridgeStore } from "../src/store.js";

test("store deduplicates completed and failed inbound messages", () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-bridge-test-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  try {
    assert.equal(
      store.claimMessage({ messageId: "om_1", chatId: "oc_1", senderId: "ou_1" }),
      true,
    );
    assert.equal(
      store.claimMessage({ messageId: "om_1", chatId: "oc_1", senderId: "ou_1" }),
      false,
    );
    store.completeMessage("om_1", "created");
    assert.equal(
      store.claimMessage({ messageId: "om_1", chatId: "oc_1", senderId: "ou_1" }),
      false,
    );

    assert.equal(
      store.claimMessage({ messageId: "om_2", chatId: "oc_1", senderId: "ou_1" }),
      true,
    );
    store.failMessage("om_2", "unknown external write state");
    assert.equal(
      store.claimMessage({ messageId: "om_2", chatId: "oc_1", senderId: "ou_1" }),
      false,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("store migrates legacy resource rows and restricts database permissions", () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-bridge-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE inbound_messages (
      message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      status TEXT NOT NULL, response_text TEXT, error_text TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE message_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL,
      file_key TEXT NOT NULL, resource_type TEXT NOT NULL, file_name TEXT,
      local_path TEXT, sha256 TEXT, size INTEGER, error_text TEXT,
      UNIQUE(message_id, file_key)
    );
    INSERT INTO inbound_messages VALUES ('om_old', 'oc', 'ou', 'completed', NULL, NULL, 10, 20);
    INSERT INTO message_resources (message_id, file_key, resource_type)
      VALUES ('om_old', 'file_old', 'file');
  `);
  legacy.close();
  const store = new BridgeStore(databasePath);
  try {
    const audit = JSON.stringify(store.messageAudit("om_old"));
    assert.match(audit, /"created_at":10/);
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("store records a per-message operation journal for safe recovery", () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-bridge-test-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  try {
    store.claimMessage({ messageId: "om_audit", chatId: "oc_1", senderId: "ou_1" });
    store.recordOperation({
      messageId: "om_audit",
      step: "agent_execution",
      status: "started",
      detail: { resourceCount: 2 },
      createdAt: 10,
    });
    store.recordOperation({
      messageId: "om_audit",
      step: "message_failed",
      status: "failed",
      detail: { externalWriteState: "unknown" },
      createdAt: 20,
    });
    assert.deepEqual(
      store.messageOperations("om_audit").map((operation) => [operation.step, operation.status]),
      [["agent_execution", "started"], ["message_failed", "failed"]],
    );
    assert.match(JSON.stringify(store.messageAudit("om_audit")), /externalWriteState/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("store keeps a bounded conversation transcript", () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-bridge-test-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  try {
    store.addConversationMessage({
      conversationKey: "oc_1:ou_1",
      role: "user",
      content: "first",
      sourceMessageId: "om_1",
      createdAt: 1,
    });
    store.addConversationMessage({
      conversationKey: "oc_1:ou_1",
      role: "assistant",
      content: "second",
      sourceMessageId: "response:om_1",
      createdAt: 2,
    });
    store.addConversationMessage({
      conversationKey: "oc_1:ou_1",
      role: "user",
      content: "third",
      sourceMessageId: "om_2",
      createdAt: 3,
    });

    const messages = store.recentConversation("oc_1:ou_1", 2);
    assert.deepEqual(
      messages.map((message) => message.content),
      ["second", "third"],
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("store filters stale transcript entries without deleting them", () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-bridge-test-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  try {
    store.addConversationMessage({
      conversationKey: "oc_1:ou_1:scope:om_1",
      role: "user",
      content: "stale",
      sourceMessageId: "om_1",
      createdAt: 10,
    });
    store.addConversationMessage({
      conversationKey: "oc_1:ou_1:scope:om_1",
      role: "assistant",
      content: "recent",
      sourceMessageId: "response:om_1",
      createdAt: 20,
    });

    assert.deepEqual(
      store.recentConversation("oc_1:ou_1:scope:om_1", 10, 15).map((message) =>
        message.content
      ),
      ["recent"],
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("store opens, updates, closes, and expires structured ticket drafts", () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-bridge-test-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  const conversationKey = "oc_1:ou_1:scope:om_1";
  try {
    const opened = store.applyDraftUpdate({
      conversationKey,
      chatId: "oc_1",
      senderId: "ou_1",
      update: {
        action: "open",
        ticketType: "内容维护",
        summary: "菜单调整，等待店铺",
        missingFields: ["关联客户 / 店铺"],
        workItemIds: [],
      },
      resources: [
        {
          type: "image",
          fileKey: "img_1",
          fileName: "menu.png",
          localPath: "/tmp/resources/menu.png",
        },
      ],
      ttlMs: 100,
      now: 1_000,
    });
    assert.ok(opened);
    assert.equal(opened.ticketType, "内容维护");
    assert.deepEqual(opened.missingFields, ["关联客户 / 店铺"]);
    assert.equal(opened.resources[0]?.fileKey, "img_1");

    const foundByParticipant = store.activeDraft({
      conversationKey: "oc_1:ou_1:scope:unrelated",
      chatId: "oc_1",
      senderId: "ou_1",
      allowParticipantFallback: true,
      now: 1_050,
    });
    assert.equal(foundByParticipant?.id, opened.id);

    store.addConversationMessage({
      conversationKey,
      role: "user",
      content: "创建客服工单并关联 T2",
      sourceMessageId: "om_followup_anchor",
      createdAt: 1_040,
    });
    const foundByReplyReference = store.activeDraft({
      conversationKey: "oc_1:ou_1:scope:om_nested_reply",
      chatId: "oc_1",
      senderId: "ou_1",
      referenceMessageIds: ["om_followup_anchor"],
      now: 1_050,
    });
    assert.equal(foundByReplyReference?.id, opened.id);

    assert.equal(
      store.activeDraft({
        conversationKey: "oc_1:ou_1:scope:threaded-reply",
        chatId: "oc_1",
        senderId: "ou_1",
        now: 1_050,
      }),
      undefined,
    );

    const updated = store.applyDraftUpdate({
      conversationKey,
      chatId: "oc_1",
      senderId: "ou_1",
      activeDraftId: opened.id,
      update: {
        action: "update",
        ticketType: "内容维护",
        summary: "店铺已补充，等待确认人确认",
        missingFields: ["是否需要确认人确认"],
        workItemIds: [],
      },
      resources: [
        {
          type: "file",
          fileKey: "file_2",
          fileName: "details.pdf",
          localPath: "/tmp/resources/details.pdf",
        },
      ],
      ttlMs: 100,
      now: 1_060,
    });
    assert.equal(updated?.summary, "店铺已补充，等待确认人确认");
    assert.deepEqual(updated?.missingFields, ["是否需要确认人确认"]);
    assert.deepEqual(updated?.resources.map((resource) => resource.fileKey), [
      "img_1",
      "file_2",
    ]);

    store.applyDraftUpdate({
      conversationKey,
      chatId: "oc_1",
      senderId: "ou_1",
      activeDraftId: opened.id,
      update: {
        action: "close",
        ticketType: "内容维护",
        summary: "已创建 #123",
        missingFields: [],
        workItemIds: ["123"],
      },
      ttlMs: 100,
      now: 1_070,
    });
    assert.equal(
      store.activeDraft({
        conversationKey,
        chatId: "oc_1",
        senderId: "ou_1",
        now: 1_080,
      }),
      undefined,
    );

    const expiring = store.applyDraftUpdate({
      conversationKey: "oc_1:ou_1:scope:om_2",
      chatId: "oc_1",
      senderId: "ou_1",
      update: {
        action: "open",
        summary: "等待补充",
        missingFields: ["任务描述"],
        workItemIds: [],
      },
      ttlMs: 10,
      now: 2_000,
    });
    assert.ok(expiring);
    assert.equal(
      store.activeDraft({
        conversationKey: expiring.conversationKey,
        chatId: "oc_1",
        senderId: "ou_1",
        now: 2_011,
      }),
      undefined,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("store does not guess between concurrent drafts for the same participant", () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-bridge-test-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  try {
    for (const [messageId, summary] of [
      ["om_t2", "T2 积分卡问题"],
      ["om_t3", "T3 内容维护"],
    ] as const) {
      store.applyDraftUpdate({
        conversationKey: `oc_1:ou_1:scope:${messageId}`,
        chatId: "oc_1",
        senderId: "ou_1",
        update: {
          action: "open",
          summary,
          missingFields: ["店铺 ID"],
          workItemIds: [],
        },
        ttlMs: 1_000,
        now: messageId === "om_t2" ? 1_000 : 1_100,
      });
      store.addConversationMessage({
        conversationKey: `oc_1:ou_1:scope:${messageId}`,
        role: "user",
        content: summary,
        sourceMessageId: `${messageId}_followup`,
        createdAt: messageId === "om_t2" ? 1_000 : 1_100,
      });
    }

    assert.equal(
      store.activeDraft({
        conversationKey: "oc_1:ou_1:scope:unscoped-message",
        chatId: "oc_1",
        senderId: "ou_1",
        allowParticipantFallback: true,
        now: 1_200,
      }),
      undefined,
    );

    assert.equal(
      store.activeDraft({
        conversationKey: "oc_1:ou_1:scope:nested-reply",
        chatId: "oc_1",
        senderId: "ou_1",
        referenceMessageIds: ["om_t2_followup"],
        now: 1_200,
      })?.summary,
      "T2 积分卡问题",
      "an explicit reply reference must select the intended draft even when another draft is open",
    );

    assert.equal(
      store.activeDraft({
        conversationKey: "oc_1:ou_1:scope:om_t3",
        chatId: "oc_1",
        senderId: "ou_1",
        now: 1_200,
      })?.summary,
      "T3 内容维护",
    );

    assert.equal(
      store.activeDraft({
        conversationKey: "oc_1:ou_2:scope:om_t3",
        chatId: "oc_1",
        senderId: "ou_2",
        allowParticipantFallback: true,
        now: 1_200,
      }),
      undefined,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("store assigns one content producer per conversation in round-robin order", () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-bridge-test-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  try {
    const input = {
      sourceChatId: "oc_producers",
      producerNames: ["Annie", "Jane", "Kiddy"],
    };
    assert.equal(
      store.assignNextProducer({ ...input, conversationKey: "draft_1", now: 1 }),
      "Annie",
    );
    assert.equal(
      store.assignNextProducer({ ...input, conversationKey: "draft_1", now: 2 }),
      "Annie",
      "the same draft must retain its producer",
    );
    assert.equal(
      store.assignNextProducer({
        sourceChatId: "oc_producers",
        conversationKey: "draft_1",
        producerNames: ["Kiddy", "Annie", "Jane"],
        now: 2,
      }),
      "Annie",
      "an existing draft stays sticky when its producer remains on a changed roster",
    );
    assert.equal(
      store.assignNextProducer({ ...input, conversationKey: "draft_2", now: 3 }),
      "Jane",
    );
    assert.equal(
      store.assignNextProducer({ ...input, conversationKey: "draft_3", now: 4 }),
      "Kiddy",
    );
    assert.equal(
      store.assignNextProducer({ ...input, conversationKey: "draft_4", now: 5 }),
      "Annie",
      "the rotation must wrap to the first producer",
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("producer rotation resets to the first member when the ordered roster changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-bridge-test-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  try {
    assert.equal(
      store.assignNextProducer({
        sourceChatId: "oc_producers",
        conversationKey: "draft_1",
        producerNames: ["Annie", "Jane"],
        now: 1,
      }),
      "Annie",
    );
    assert.equal(
      store.assignNextProducer({
        sourceChatId: "oc_producers",
        conversationKey: "draft_2",
        producerNames: ["Kiddy", "Annie", "Jane"],
        now: 2,
      }),
      "Kiddy",
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("producer rotation continues after the bridge store restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-bridge-test-"));
  const databasePath = join(directory, "bridge.sqlite");
  const input = {
    sourceChatId: "oc_producers",
    producerNames: ["Annie", "Jane"],
  };
  let store = new BridgeStore(databasePath);
  try {
    assert.equal(
      store.assignNextProducer({ ...input, conversationKey: "draft_1", now: 1 }),
      "Annie",
    );
    store.close();
    store = new BridgeStore(databasePath);
    assert.equal(
      store.assignNextProducer({ ...input, conversationKey: "draft_2", now: 2 }),
      "Jane",
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
