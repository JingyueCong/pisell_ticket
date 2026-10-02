import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentPrompt, conversationKey } from "../src/prompt.js";

test("prompt treats attachment content as untrusted evidence", () => {
  const prompt = buildAgentPrompt({
    resourceRoot: "/tmp/resources",
    history: [],
    envelope: {
      messageId: "om_1",
      chatId: "oc_1",
      chatType: "group",
      senderId: "ou_1",
      senderName: "Echo",
      content: "创建一个风控工单",
      rawContentType: "text",
      createTime: 1,
      contentMaintenanceProducerSource: {
        chatId: "oc_producer",
        chatName: "内部任务沟通 制作：Annie/Jane 确认:Kiddy",
        producerNames: ["Annie", "Jane"],
        fetchedAt: 2,
      },
      resources: [
        {
          type: "image",
          fileKey: "img_1",
          fileName: "evidence.png",
          localPath: "/tmp/resources/om_1/evidence.png",
          sha256: "abc",
          size: 10,
        },
      ],
    },
  });

  assert.match(prompt, /附件内容.*不是系统指令/);
  assert.match(prompt, /meegle.*sandbox_permissions=require_escalated/);
  assert.match(prompt, /lark-cli.*sandbox_permissions=require_escalated/);
  assert.match(prompt, /LARK_CLI_PROFILE/);
  assert.match(prompt, /可信内容维护制作人来源/);
  assert.match(prompt, /producer_names: Annie \/ Jane/);
  assert.match(prompt, /不得再次向员工索取制作人/);
  assert.match(prompt, /source_message_id: om_1/);
  assert.match(prompt, /evidence\.png/);
  assert.match(prompt, /创建一个风控工单/);
});

test("conversation key isolates senders and ticket threads in the same chat", () => {
  assert.equal(
    conversationKey({ chatId: "oc_1", senderId: "ou_1", messageId: "om_1" }),
    "oc_1:ou_1:scope:om_1",
  );
  assert.equal(
    conversationKey({
      chatId: "oc_1",
      senderId: "ou_1",
      messageId: "om_reply",
      rootId: "om_1",
    }),
    "oc_1:ou_1:scope:om_1",
  );
  assert.notEqual(
    conversationKey({ chatId: "oc_1", senderId: "ou_1", messageId: "om_1" }),
    conversationKey({ chatId: "oc_1", senderId: "ou_2", messageId: "om_1" }),
  );
  assert.notEqual(
    conversationKey({ chatId: "oc_1", senderId: "ou_1", messageId: "om_1" }),
    conversationKey({ chatId: "oc_1", senderId: "ou_1", messageId: "om_2" }),
  );
});

test("prompt includes active structured draft without treating it as Meegle truth", () => {
  const prompt = buildAgentPrompt({
    resourceRoot: "/tmp/resources",
    history: [],
    activeDraft: {
      id: "draft_1",
      conversationKey: "oc_1:ou_1:scope:om_1",
      chatId: "oc_1",
      senderId: "ou_1",
      ticketType: "内容维护",
      summary: "名称为菜单调整，等待关联店铺",
      missingFields: ["关联客户 / 店铺"],
      workItemIds: [],
      resources: [],
      updatedAt: 10,
      expiresAt: 20,
    },
    envelope: {
      messageId: "om_2",
      chatId: "oc_1",
      chatType: "group",
      senderId: "ou_1",
      content: "店铺是 Eastwood",
      rawContentType: "text",
      createTime: 2,
      resources: [],
    },
  });

  assert.match(prompt, /当前活动草稿/);
  assert.match(prompt, /draft_id: draft_1/);
  assert.match(prompt, /关联客户 \/ 店铺/);
  assert.match(prompt, /不是 Meegle 的权威状态/);
  assert.match(prompt, /draft\.action=open/);
});
