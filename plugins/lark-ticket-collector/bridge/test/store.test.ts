import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
