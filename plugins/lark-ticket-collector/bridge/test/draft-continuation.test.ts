import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveDraftRouteCorrectionPolicy,
  draftIncludesContentMaintenance,
  enforceDraftRouteContinuation,
  isDraftRouteCorrection,
} from "../src/draft-continuation.js";
import type { DraftMemoryUpdate, DraftSnapshot } from "../src/types.js";

const activeDraft: DraftSnapshot = {
  id: "draft_t2",
  conversationKey: "oc_1:ou_1:scope:om_original",
  chatId: "oc_1",
  senderId: "ou_1",
  ticketType: "客服工单 + T2非核心阻断性问题",
  summary: "7886 Hats on Queen 的商品显示 Sold Out",
  missingFields: ["APP版本号", "软件版本"],
  workItemIds: [],
  resources: [],
  updatedAt: 1,
  expiresAt: 2,
};

const openedT3: DraftMemoryUpdate = {
  action: "open",
  ticketType: "客服工单 + 内容维护",
  summary: "改为 T3 内容维护",
  missingFields: ["是否需要确认人确认"],
  workItemIds: [],
};

test("route corrections continue the referenced draft instead of opening a blank draft", () => {
  const messageText = "不用T2工单，建立内容工单即可";
  assert.equal(isDraftRouteCorrection(messageText), true);
  assert.deepEqual(
    enforceDraftRouteContinuation({ messageText, activeDraft, draft: openedT3 }),
    {
      draft: { ...openedT3, action: "update" },
      continued: true,
    },
  );
});

test("a post-creation T3-to-T2 correction is locked to the existing bundle", () => {
  const createdT3: DraftSnapshot = {
    ...activeDraft,
    id: "draft_t3_created",
    ticketType: "客服工单 + T3内容维护",
    summary: "已创建客服工单并关联内容维护工单",
    workItemIds: ["7133330739", "7133330740"],
  };
  const messageText = "创建错了，是T2工单，请调整，删除内容工单";

  assert.equal(isDraftRouteCorrection(messageText), true);
  assert.deepEqual(
    deriveDraftRouteCorrectionPolicy({ messageText, activeDraft: createdT3 }),
    {
      mode: "replace_content_maintenance_with_t2",
      authoritative: true,
      targetCustomerIssueOption: "T2非核心阻断性问题类流转升级",
      targetPairedWorkItemType: "blocking_issue",
      obsoletePairedWorkItemType: "content_maintenance",
      preserveExistingCustomer: true,
      cleanupRequested: true,
      cleanupMode: "detach_then_cancel_if_supported",
    },
  );
});

test("post-creation cleanup policy does not affect normal or pre-submit routes", () => {
  const cases: Array<{ messageText: string; activeDraft?: DraftSnapshot }> = [
    { messageText: "创建一张T2工单", activeDraft },
    { messageText: "查询T2工单，删除内容工单", activeDraft },
    {
      messageText: "创建错了，是T2工单，请调整，删除内容工单",
      activeDraft: {
        ...activeDraft,
        ticketType: "客服工单 + T3内容维护",
        workItemIds: [],
      },
    },
    {
      messageText: "创建错了，是T2工单，请调整，删除内容工单",
      activeDraft: { ...activeDraft, ticketType: "客服工单 + T2阻断性问题" },
    },
    {
      messageText: "另外新建一张T2工单，并删除旧内容工单",
      activeDraft: {
        ...activeDraft,
        ticketType: "客服工单 + T3内容维护",
        workItemIds: ["1", "2"],
      },
    },
  ];
  for (const input of cases) {
    assert.equal(deriveDraftRouteCorrectionPolicy(input), undefined, input.messageText);
  }
});

test("an explicit request for another new ticket remains a new draft", () => {
  const messageText = "不用修改当前T2，另外新建一张T3内容维护工单";
  assert.equal(isDraftRouteCorrection(messageText), false);
  assert.deepEqual(
    enforceDraftRouteContinuation({ messageText, activeDraft, draft: openedT3 }),
    { draft: openedT3, continued: false },
  );
});

test("route wording cannot continue a draft when no active draft was resolved", () => {
  const messageText = "不用T2工单，建立T3内容工单即可";
  assert.deepEqual(
    enforceDraftRouteContinuation({ messageText, draft: openedT3 }),
    { draft: openedT3, continued: false },
  );
});

test("customer bundle summaries retain the T3 producer binding across follow-ups", () => {
  assert.equal(
    draftIncludesContentMaintenance({
      ticketType: "customer_bundle",
      summary: "已为新东方鲜生创建客服工单并关联T3内容维护",
    }),
    true,
  );
  assert.equal(
    draftIncludesContentMaintenance({
      ticketType: "customer_bundle",
      summary: "客服工单关联 T2 阻断性问题",
    }),
    false,
  );
});
