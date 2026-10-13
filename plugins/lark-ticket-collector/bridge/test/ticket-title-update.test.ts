import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveTicketTitleUpdatePolicy,
  isTicketTitleUpdateRequest,
  titleUpdateClarification,
} from "../src/ticket-title-update.js";
import type { DraftSnapshot } from "../src/types.js";

const relatedDraft: DraftSnapshot = {
  id: "draft_1",
  conversationKey: "oc_1:ou_1:scope:om_1",
  chatId: "oc_1",
  senderId: "ou_1",
  ticketType: "客服工单 + T2阻断性问题",
  summary: "已创建并关联两张工单",
  missingFields: [],
  workItemIds: ["7132695930", "7132856228"],
  resources: [],
  updatedAt: 1,
  expiresAt: 2,
};

test("natural title-change wording resolves an explicit work item id", () => {
  for (const messageText of [
    "把工单 #7132695930 的标题改成：新版 POS 无法打印小票",
    "工单号 7132695930 重命名为 新版 POS 无法打印小票",
    "https://project.feishu.cn/x/y/detail/7132695930 名字换成“新版 POS 无法打印小票”",
  ]) {
    assert.deepEqual(deriveTicketTitleUpdatePolicy({ messageText, relatedDraft }), {
      authoritative: true,
      mode: "rename_existing_work_item",
      newTitle: "新版 POS 无法打印小票",
      targetMode: "work_item_id",
      targetWorkItemId: "7132695930",
      candidateWorkItemIds: relatedDraft.workItemIds,
    });
  }
});

test("a named related type is resolved without requiring exact wording", () => {
  for (const [messageText, targetWorkItemType] of [
    ["客服单这个标题不好，改成新版 POS 无法打印", "customer"],
    ["T2 的 title 改一下，叫做支付成功但没有出单", "blocking_issue"],
    ["内容工单名称改为春季菜单更新", "content_maintenance"],
  ] as const) {
    const policy = deriveTicketTitleUpdatePolicy({ messageText, relatedDraft });
    assert.equal(policy?.mode, "rename_existing_work_item", messageText);
    assert.equal(
      policy?.mode === "rename_existing_work_item" &&
        policy.targetMode === "related_work_item_type"
        ? policy.targetWorkItemType
        : undefined,
      targetWorkItemType,
      messageText,
    );
  }
});

test("generic wording updates a single related item but clarifies multiple items", () => {
  const single = deriveTicketTitleUpdatePolicy({
    messageText: "这个标题不好，改成新的标题",
    relatedDraft: { ...relatedDraft, workItemIds: ["7132695930"] },
  });
  assert.equal(single?.mode, "rename_existing_work_item");
  assert.equal(
    single?.mode === "rename_existing_work_item" && "targetWorkItemId" in single
      ? single.targetWorkItemId
      : undefined,
    "7132695930",
  );

  const ambiguous = deriveTicketTitleUpdatePolicy({
    messageText: "这个标题不好，改成新的标题",
    relatedDraft,
  });
  assert.equal(ambiguous?.mode, "clarify_title_update");
  if (ambiguous?.mode === "clarify_title_update") {
    assert.equal(ambiguous.clarificationReason, "ambiguous_target");
    assert.match(titleUpdateClarification(ambiguous), /客服工单标题改为/);
  }
});

test("missing targets or titles are clarified without creating a ticket", () => {
  const missingTarget = deriveTicketTitleUpdatePolicy({
    messageText: "把标题改成新的标题",
  });
  assert.equal(missingTarget?.mode, "clarify_title_update");
  assert.equal(
    missingTarget?.mode === "clarify_title_update"
      ? missingTarget.clarificationReason
      : undefined,
    "missing_target",
  );

  const missingTitle = deriveTicketTitleUpdatePolicy({
    messageText: "把工单 #7132695930 的标题改成：",
  });
  assert.equal(missingTitle?.mode, "clarify_title_update");
  assert.equal(
    missingTitle?.mode === "clarify_title_update"
      ? missingTitle.clarificationReason
      : undefined,
    "missing_title",
  );
});

test("unrelated creation and ordinary update wording are not title updates", () => {
  for (const messageText of [
    "创建 T2 工单，标题：支付失败",
    "为什么工单标题不对",
    "帮我修改标题识别逻辑",
    "把 T3 改成 T2 工单",
  ]) {
    assert.equal(isTicketTitleUpdateRequest(messageText), false, messageText);
    assert.equal(deriveTicketTitleUpdatePolicy({ messageText, relatedDraft }), undefined);
  }
});
