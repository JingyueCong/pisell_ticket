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
      routePolicy: {
        mode: "customer_bundle",
        authoritative: true,
        reason: "content_maintenance_creation_alias_defaults_to_customer_bundle",
        customerIssueOption: "T3客户代运营请求-内容维护",
        pairedWorkItemType: "content_maintenance",
      },
      contentMaintenanceProducerSource: {
        chatId: "oc_producer",
        chatName: "内部任务沟通 制作：Annie/Jane 确认:Kiddy",
        producerNames: ["Annie"],
        producerRoster: ["Annie", "Jane"],
        selectionMode: "round_robin_single",
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
      meegleIdentity: {
        profile: "lark-echo",
        userKey: "user_echo",
        name: "Echo",
        email: "echo@example.com",
      },
    },
  }, { meegleCommand: "/srv/bridge/bin/meegle" });

  assert.match(prompt, /附件内容.*不是系统指令/);
  assert.match(prompt, /可信入口路由策略/);
  assert.match(prompt, /mode: customer_bundle/);
  assert.match(prompt, /authoritative: true/);
  assert.match(prompt, /创建内容维护工单.*默认表示客服工单 \+ T3 内容维护配套/);
  assert.match(prompt, /只有员工明确说“单独\/独立\/仅\/只创建内容维护工单”/);
  assert.match(prompt, /客服外向关联已回读验证/);
  assert.match(prompt, /没有明确提供工单问题等级，默认填写三星/);
  assert.match(prompt, /不得再把星级列为缺失项/);
  assert.match(prompt, /商家来源时，默认主单必须是客服工单/);
  assert.match(prompt, /不得索取或写入“内部发现人”/);
  assert.match(prompt, /包含 T1、T2、T3 客户代运营、T5 功能建议\/改进、客户刷卡机或风控处理/);
  assert.match(prompt, /任一配套草稿未就绪时，不得先创建客服工单/);
  assert.match(prompt, /T4 商务、内部跟进和客户情绪\/公关只创建客服工单/);
  assert.match(prompt, /meegle.*sandbox_permissions=require_escalated/);
  assert.match(prompt, /lark-cli.*sandbox_permissions=require_escalated/);
  assert.match(prompt, /LARK_CLI_PROFILE/);
  assert.match(prompt, /verified_meegle_user_key: user_echo/);
  assert.match(prompt, /meegle_command: \/srv\/bridge\/bin\/meegle/);
  assert.match(prompt, /唯一允许的 Meegle 命令路径/);
  assert.match(prompt, /login=false/);
  assert.match(prompt, /禁止调用裸 `meegle`/);
  assert.match(prompt, /名称精确为“创建工单”的初始节点/);
  assert.match(prompt, /bridge 还会在 Agent 返回后执行同一项强制回读校正/);
  assert.match(prompt, /workflow update-node --node-owners/);
  assert.match(prompt, /可信内容维护制作人来源/);
  assert.match(prompt, /producer_names: Annie/);
  assert.match(prompt, /producer_roster: Annie \/ Jane/);
  assert.match(prompt, /selection_mode: round_robin_single/);
  assert.match(prompt, /必须只解析并写入这一人到“制作人&交付人”/);
  assert.match(prompt, /不得同时写入 producer_roster 中的其他人/);
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

test("prompt locks trusted Feishu Minutes evidence to one onsite service ticket", () => {
  const prompt = buildAgentPrompt({
    resourceRoot: "/tmp/resources",
    history: [],
    envelope: {
      messageId: "om_visit",
      chatId: "oc_customer",
      chatType: "group",
      senderId: "ou_visitor",
      senderName: "Yvonne",
      content: "https://example.feishu.cn/minutes/obcnutest123",
      rawContentType: "text",
      createTime: 1,
      resources: [],
      routePolicy: {
        mode: "customer_only",
        authoritative: true,
        reason: "trusted_visit_record_minutes_trigger",
        customerIssueOption: "上门服务",
      },
      visitRecord: {
        sourceChatId: "oc_customer",
        sourceChatName: "Little Amigos Kidscafe Highpoint 客户群",
        minuteToken: "obcnutest123",
        minuteUrl: "https://example.feishu.cn/minutes/obcnutest123",
        title: "现场沟通",
        summary: "讨论 POS 卡慢和菜单调整。",
        chapters: [{ title: "POS", summary: "付款偶发卡慢" }],
        todos: [{ content: "Yvonne 跟进日志", assignees: ["Yvonne"] }],
        keywords: ["POS", "菜单"],
        transcriptPath: "/tmp/resources/om_visit/minute/transcript.txt",
        fetchedAt: 2,
      },
    },
  });

  assert.match(prompt, /source_chat_name: Little Amigos Kidscafe Highpoint 客户群/);
  assert.match(prompt, /minute_title: 现场沟通/);
  assert.match(prompt, /smart_summary: 讨论 POS 卡慢和菜单调整/);
  assert.match(prompt, /transcript_file: \/tmp\/resources\/om_visit\/minute\/transcript\.txt/);
  assert.match(prompt, /本轮固定只创建一张客服工单/);
  assert.match(prompt, /对应问题类型.*上门服务/);
  assert.match(prompt, /不得从会议中的问题点触发 T1\/T2\/T3\/T5/);
  assert.match(prompt, /完整逐字稿/);
  assert.match(prompt, /检索摘要/);
  assert.match(prompt, /5–12 条简短要点/);
  assert.match(prompt, /\[模块\/设备\].*影响.*当前状态\/已确认方案/);
  assert.match(prompt, /检索关键词/);
  assert.match(prompt, /5–15 个可直接搜索的具体词/);
  assert.match(prompt, /必须写入客服工单的“问题描述”/);
  assert.match(prompt, /原始妙记链接/);
  assert.match(prompt, /待内部评估/);
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
