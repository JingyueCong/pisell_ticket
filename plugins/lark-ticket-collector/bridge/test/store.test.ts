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
