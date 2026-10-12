import assert from "node:assert/strict";
import test from "node:test";

import { enforceDeterministicOutcome } from "../src/outcome-guard.js";
import type { AgentResult, DraftSnapshot, InboundEnvelope } from "../src/types.js";

const envelope: InboundEnvelope = {
  messageId: "om_followup",
  chatId: "oc_ticket",
  chatType: "group",
  senderId: "ou_employee",
  content: "涅槃df",
  rawContentType: "text",
  createTime: 1,
  resources: [],
  routePolicy: {
    mode: "unspecified",
    authoritative: false,
    reason: "not_a_new_creation_request",
  },
};

const activeDraft: DraftSnapshot = {
  id: "draft-1",
  conversationKey: "conversation-1",
  chatId: "oc_ticket",
  senderId: "ou_employee",
  ticketType: "客服工单 + 内容维护",
  summary: "为 8721 Annie 创建修改商品图片客服工单和 T3 内容维护；缺少商家问题提出人",
  missingFields: ["商家问题提出人"],
  workItemIds: ["6018057121"],
  resources: [],
  updatedAt: 1,
  expiresAt: 2,
};

function result(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    text: "暂未提交：提交接口当前拒绝在线元数据中的必填字段（问题来源、对应问题类型）。",
    draft: {
      action: "update",
      ticketType: "客服工单 + 内容维护",
      summary: "商家问题提出人为涅槃df，提交接口拒绝在线必填字段",
      missingFields: ["提交接口接受问题来源与对应问题类型字段"],
      workItemIds: ["6018057121"],
    },
    workItemOutcomes: [],
    attachmentArchive: {
      status: "pending",
      expectedBindings: 0,
      verifiedBindings: 0,
      targets: [],
    },
    diagnostics: [],
    ...overrides,
  };
}

test("T3 follow-up asks only for the genuinely missing problem source", () => {
  const guarded = enforceDeterministicOutcome({
    envelope,
    history: [],
    activeDraft,
    result: result(),
  });

  assert.equal(guarded.corrected, true);
  assert.equal(guarded.reason, "missing_fields");
  assert.deepEqual(guarded.result.draft.missingFields, ["问题来源"]);
  assert.match(guarded.result.text, /请补充问题来源/);
  assert.doesNotMatch(guarded.result.text, /接口.*拒绝/);
  assert.doesNotMatch(guarded.result.text, /对应问题类型/);
});

test("first pass asks for source together with model-detected missing fields", () => {
  const guarded = enforceDeterministicOutcome({
    envelope: {
      ...envelope,
      content: "创建客服工单并关联内容工单 修改商品图片",
      routePolicy: {
        mode: "customer_bundle",
        authoritative: true,
        customerIssueOption: "T3客户代运营请求-内容维护",
        pairedWorkItemType: "content_maintenance",
        reason: "content_maintenance_creation_alias_defaults_to_customer_bundle",
      },
    },
    history: [],
    result: result({
      text: "请补充商家问题提出人姓名。",
      draft: {
        action: "open",
        ticketType: "客服工单 + 内容维护",
        summary: "修改商品图片",
        missingFields: ["商家问题提出人"],
        workItemIds: [],
      },
    }),
  });

  assert.deepEqual(guarded.result.draft.missingFields, ["商家问题提出人", "问题来源"]);
  assert.match(guarded.result.text, /商家问题提出人/);
  assert.match(guarded.result.text, /问题来源/);
});

test("a claimed interface failure without broker evidence is not presented as fact", () => {
  const guarded = enforceDeterministicOutcome({
    envelope: { ...envelope, content: "继续提交" },
    history: [
      {
        role: "user",
        content: "问题来源：WhatsApp",
        sourceMessageId: "om_1",
        createdAt: 1,
      },
    ],
    activeDraft: { ...activeDraft, summary: "T3 内容维护，来源 WhatsApp" },
    result: result({
      draft: { ...result().draft, missingFields: [] },
    }),
  });

  assert.equal(guarded.reason, "unsupported_api_failure_claim");
  assert.match(guarded.result.text, /没有检测到可核验/);
  assert.doesNotMatch(guarded.result.text, /接口当前拒绝/);
});

test("a real broker failure may remain an API failure response", () => {
  const original = result({
    draft: { ...result().draft, missingFields: [] },
    commandEvidence: [
      { tool: "meegle", operation: "workitem create", exitCode: 1, policyDenied: false },
    ],
  });
  const guarded = enforceDeterministicOutcome({
    envelope: { ...envelope, content: "问题来源 WhatsApp，继续提交" },
    history: [],
    activeDraft: { ...activeDraft, summary: "T3 内容维护，来源 WhatsApp" },
    result: original,
  });

  assert.equal(guarded.corrected, false);
  assert.equal(guarded.result.text, original.text);
});

test("a failed read does not prove that the create interface rejected a submission", () => {
  const guarded = enforceDeterministicOutcome({
    envelope: { ...envelope, content: "问题来源 WhatsApp，继续提交" },
    history: [],
    activeDraft: { ...activeDraft, summary: "T3 内容维护，来源 WhatsApp" },
    result: result({
      draft: { ...result().draft, missingFields: [] },
      commandEvidence: [
        { tool: "meegle", operation: "workitem query", exitCode: 1, policyDenied: false },
      ],
    }),
  });

  assert.equal(guarded.reason, "unsupported_api_failure_claim");
  assert.match(guarded.result.text, /没有检测到可核验/);
});
