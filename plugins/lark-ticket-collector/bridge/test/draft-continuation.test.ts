import assert from "node:assert/strict";
import test from "node:test";

import {
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
