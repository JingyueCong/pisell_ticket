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

test("ambiguous CRM candidates are listed instead of asking for the store again", () => {
  const guarded = enforceDeterministicOutcome({
    envelope: { ...envelope, content: "店铺 ID 8793" },
    history: [],
    activeDraft: {
      ...activeDraft,
      summary: "T3 域名设置检查；店铺 ID 8793；CRM 匹配到两个候选",
      missingFields: ["客户/店铺"],
      workItemIds: ["6416657899", "6168016739"],
    },
    customerCandidates: [
      { workItemId: "6416657899", name: "8793 🌺Basic + sexycloakroom（AU）" },
      { workItemId: "6168016739", name: "8793 SexyCloakRoomSYD" },
    ],
    result: result({
      text: "请提供客户名称、店铺名称或店铺 ID。",
      draft: {
        action: "update",
        ticketType: "客服工单 + 内容维护",
        summary: "T3 域名设置检查；店铺 ID 8793；CRM 匹配到两个候选",
        missingFields: ["客户/店铺"],
        workItemIds: ["6416657899", "6168016739"],
      },
    }),
  });

  assert.equal(guarded.reason, "missing_fields");
  assert.match(guarded.result.text, /8793 🌺Basic \+ sexycloakroom（AU）/u);
  assert.match(guarded.result.text, /8793 SexyCloakRoomSYD/u);
  assert.match(guarded.result.text, /第一个\/第二个/u);
  assert.doesNotMatch(guarded.result.text, /请提供客户名称、店铺名称或店铺 ID/u);
});

test("a deterministic CRM selection clears the generic customer missing field", () => {
  const guarded = enforceDeterministicOutcome({
    envelope: { ...envelope, content: "SYD" },
    history: [],
    activeDraft,
    selectedCustomerCandidate: {
      workItemId: "6168016739",
      name: "8793 SexyCloakRoomSYD",
    },
    result: result({
      text: "继续处理",
      draft: {
        action: "update",
        ticketType: "客服工单 + 内容维护",
        summary: "已选择 8793 SexyCloakRoomSYD",
        missingFields: ["客户/店铺"],
        workItemIds: ["6168016739"],
      },
    }),
  });

  assert.deepEqual(guarded.result.draft.missingFields, ["问题来源"]);
  assert.doesNotMatch(guarded.result.text, /客户\/店铺/u);
});

test("a complete duplicate-candidate reply is preserved", () => {
  const originalText = [
    "系统发现以下可能重复的工单：",
    "1. 菜单图片更新（#7062811769）",
    "2. 菜单配置调整（#6856848454）",
    "请回复“复用 #工单号”，或回复“仍创建”。",
  ].join("\n");
  const guarded = enforceDeterministicOutcome({
    envelope: { ...envelope, content: "bella 企业微信 all" },
    history: [],
    activeDraft,
    result: result({
      text: originalText,
      draft: {
        action: "update",
        ticketType: "客服工单 + 内容维护",
        summary: "查重发现两个历史候选",
        missingFields: ["重复候选处理选择（仍创建或复用）"],
        workItemIds: ["7062811769", "6856848454"],
      },
      workItemOutcomes: [
        { workItemId: "7062811769", role: "customer", disposition: "queried" },
        { workItemId: "6856848454", role: "paired", disposition: "queried" },
      ],
    }),
  });

  assert.equal(guarded.result.text, originalText);
  assert.deepEqual(guarded.result.draft.missingFields, ["重复候选处理选择"]);
  assert.doesNotMatch(guarded.result.text, /请补充该信息/u);
});

test("duplicate candidates receive a deterministic choice list when agent text is incomplete", () => {
  const guarded = enforceDeterministicOutcome({
    envelope: { ...envelope, content: "继续" },
    history: [],
    activeDraft,
    result: result({
      text: "请补充重复候选处理选择。",
      draft: {
        action: "update",
        ticketType: "客服工单 + 内容维护",
        summary: "查重发现三个历史候选",
        missingFields: ["重复候选处理选择"],
        workItemIds: ["7062811769", "6856848454", "7062700144"],
      },
      workItemOutcomes: [
        { workItemId: "7062811769", role: "customer", disposition: "queried" },
        { workItemId: "6856848454", role: "paired", disposition: "queried" },
        { workItemId: "7062700144", role: "paired", disposition: "queried" },
      ],
    }),
  });

  assert.match(guarded.result.text, /1\. 工单 #7062811769/u);
  assert.match(guarded.result.text, /2\. 工单 #6856848454/u);
  assert.match(guarded.result.text, /3\. 工单 #7062700144/u);
  assert.match(guarded.result.text, /复用 #工单号/u);
  assert.match(guarded.result.text, /仍创建/u);
  assert.doesNotMatch(guarded.result.text, /重复候选处理选择：请补充该信息/u);
});

test("duplicate choices and ordinary missing fields are rendered together", () => {
  const guarded = enforceDeterministicOutcome({
    envelope: { ...envelope, content: "继续" },
    history: [],
    activeDraft,
    result: result({
      text: "请补充信息。",
      draft: {
        action: "update",
        ticketType: "客服工单 + 内容维护",
        summary: "等待来源和重复候选选择",
        missingFields: ["问题来源", "重复候选处理选择"],
        workItemIds: ["7062811769"],
      },
      workItemOutcomes: [
        { workItemId: "7062811769", role: "customer", disposition: "queried" },
      ],
    }),
  });

  assert.match(guarded.result.text, /问题来源/u);
  assert.match(guarded.result.text, /工单 #7062811769/u);
  assert.match(guarded.result.text, /复用 #工单号/u);
});

test("missing duplicate details ask for a retry instead of leaking an internal field", () => {
  const guarded = enforceDeterministicOutcome({
    envelope: { ...envelope, content: "继续" },
    history: [],
    activeDraft,
    result: result({
      text: "请补充重复候选处理选择。",
      draft: {
        action: "update",
        ticketType: "客服工单 + 内容维护",
        summary: "查重结果不完整",
        missingFields: ["重复候选处理选择"],
        workItemIds: [],
      },
      workItemOutcomes: [],
    }),
  });

  assert.match(guarded.result.text, /候选详情读取不完整/u);
  assert.match(guarded.result.text, /重新查重/u);
  assert.doesNotMatch(guarded.result.text, /请补充该信息/u);
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
