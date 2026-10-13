import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveBlockingFeedbackPolicy,
  shouldApplyBlockingFeedbackPolicy,
} from "../src/blocking-feedback.js";

test("explicit internal discovery overrides a merchant customer-service source", () => {
  assert.deepEqual(
    deriveBlockingFeedbackPolicy({
      currentText: "创建 T2 工单，反馈类型是内部发现，问题来源企业微信",
    }),
    {
      feedbackType: "内部发现",
      authoritative: true,
      source: "employee_explicit_current",
      internalDiscoverer: "verified_submitter",
    },
  );
});

test("explicit merchant feedback can replace a previous internal selection", () => {
  assert.deepEqual(
    deriveBlockingFeedbackPolicy({
      currentText: "不是内部发现，改成商家反馈",
      priorUserTexts: ["这个是内部发现"],
    }),
    {
      feedbackType: "商家反馈",
      authoritative: true,
      source: "employee_explicit_current",
      internalDiscoverer: "omit",
    },
  );
});

test("an explicit draft selection survives later field-completion messages", () => {
  assert.deepEqual(
    deriveBlockingFeedbackPolicy({
      currentText: "终端是 POS 收银机",
      priorUserTexts: ["建 T2，这是内部发现"],
    }),
    {
      feedbackType: "内部发现",
      authoritative: true,
      source: "employee_explicit_draft_context",
      internalDiscoverer: "verified_submitter",
    },
  );
});

test("known merchant channels and unknown sources use merchant feedback", () => {
  assert.equal(
    deriveBlockingFeedbackPolicy({ currentText: "企微群里客户反馈 POS 卡住" }).source,
    "known_merchant_channel",
  );
  assert.deepEqual(deriveBlockingFeedbackPolicy({ currentText: "POS 卡住了" }), {
    feedbackType: "商家反馈",
    authoritative: true,
    source: "default_merchant",
    internalDiscoverer: "omit",
  });
});

test("a comparison of both labels is not mistaken for an explicit choice", () => {
  assert.equal(
    deriveBlockingFeedbackPolicy({ currentText: "商家反馈和内部发现有什么区别？" })
      .source,
    "default_merchant",
  );
});

test("feedback policy is scoped to blocking routes or blocking drafts", () => {
  assert.equal(
    shouldApplyBlockingFeedbackPolicy({
      routePolicy: {
        mode: "customer_bundle",
        authoritative: true,
        reason: "t2_creation_alias",
        pairedWorkItemType: "blocking_issue",
      },
    }),
    true,
  );
  assert.equal(
    shouldApplyBlockingFeedbackPolicy({
      routePolicy: {
        mode: "customer_bundle",
        authoritative: true,
        reason: "t3_creation_alias",
        pairedWorkItemType: "content_maintenance",
      },
    }),
    false,
  );
  assert.equal(
    shouldApplyBlockingFeedbackPolicy({
      routePolicy: {
        mode: "unspecified",
        authoritative: false,
        reason: "not_a_new_creation_request",
      },
      activeDraft: {
        id: "draft-1",
        conversationKey: "conversation-1",
        chatId: "oc-1",
        senderId: "ou-1",
        ticketType: "客服工单 + T2 阻断性问题",
        summary: "POS 卡住",
        missingFields: ["终端"],
        workItemIds: [],
        resources: [],
        updatedAt: 1,
        expiresAt: 2,
      },
    }),
    true,
  );
});
