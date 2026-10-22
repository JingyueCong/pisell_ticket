import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCreateNewDuplicateSelection,
  draftNeedsDuplicateSelection,
  employeeSelectedCreateNew,
  isDuplicateSelectionField,
} from "../src/duplicate-selection.js";
import type { DraftSnapshot } from "../src/types.js";

const draft: DraftSnapshot = {
  id: "draft-duplicate",
  conversationKey: "conversation-duplicate",
  chatId: "oc_duplicate",
  senderId: "ou_employee",
  ticketType: "客服工单 + T2 阻断性问题",
  summary: "8714 后台沽清库存后 Kiosk 仍可点餐；问题来源为企业微信",
  missingFields: ["相似工单处理选择"],
  workItemIds: ["6018603489", "7070121271"],
  resources: [],
  updatedAt: 1,
  expiresAt: 2,
};

test("similar-ticket wording is treated as the duplicate selection field", () => {
  assert.equal(isDuplicateSelectionField("相似工单处理选择"), true);
  assert.equal(isDuplicateSelectionField("重复候选处理选择（仍创建或复用）"), true);
  assert.equal(draftNeedsDuplicateSelection(draft), true);
});

test("short create-new replies resolve the current duplicate decision", () => {
  for (const messageText of [
    "仍创建 企业微信",
    "重新创建",
    "不要复用历史工单",
    "忽略相似候选，新建独立工单",
  ]) {
    assert.equal(
      employeeSelectedCreateNew({ messageText, activeDraft: draft }),
      true,
      messageText,
    );
  }
});

test("create-new wording does not affect drafts that are not awaiting duplicate choice", () => {
  assert.equal(
    employeeSelectedCreateNew({
      messageText: "重新创建",
      activeDraft: { missingFields: ["客户/店铺"] },
    }),
    false,
  );
});

test("resolved choice keeps the current draft and drops queried duplicate IDs", () => {
  const resolved = applyCreateNewDuplicateSelection({
    ...draft,
    missingFields: ["问题来源", "相似工单处理选择"],
  });

  assert.equal(resolved.id, draft.id);
  assert.deepEqual(resolved.workItemIds, []);
  assert.deepEqual(resolved.missingFields, ["问题来源"]);
  assert.match(resolved.summary, /仍创建独立工单，不复用历史候选/u);
});
