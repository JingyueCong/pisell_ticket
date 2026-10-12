import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCustomerCandidateSelection,
  draftNeedsCustomerResolution,
  selectCustomerCandidate,
} from "../src/customer-candidates.js";
import type { CustomerCrmCandidate, DraftSnapshot } from "../src/types.js";

const candidates: CustomerCrmCandidate[] = [
  { workItemId: "6416657899", name: "8793 🌺Basic + sexycloakroom（AU）" },
  { workItemId: "6168016739", name: "8793 SexyCloakRoomSYD" },
];

const draft: DraftSnapshot = {
  id: "draft-1",
  conversationKey: "conversation-1",
  chatId: "oc-1",
  senderId: "ou-1",
  ticketType: "客服工单 + 内容维护",
  summary: "T3 域名设置检查；店铺 ID 8793；CRM 匹配到两个候选",
  missingFields: ["客户/店铺", "问题来源"],
  workItemIds: ["6416657899", "6168016739", "other-history-id"],
  resources: [],
  updatedAt: 1,
  expiresAt: 2,
};

test("detects an unresolved customer candidate draft", () => {
  assert.equal(draftNeedsCustomerResolution(draft), true);
  assert.equal(
    draftNeedsCustomerResolution({ ...draft, missingFields: ["问题来源"] }),
    false,
  );
});

test("selects a customer by ordinal, distinguishing token, or CRM ID", () => {
  assert.equal(selectCustomerCandidate("第一个", candidates)?.workItemId, "6416657899");
  assert.equal(selectCustomerCandidate("选2", candidates)?.workItemId, "6168016739");
  assert.equal(selectCustomerCandidate("AU", candidates)?.workItemId, "6416657899");
  assert.equal(selectCustomerCandidate("是 SYD 那个", candidates)?.workItemId, "6168016739");
  assert.equal(selectCustomerCandidate("6168016739", candidates)?.workItemId, "6168016739");
  assert.equal(selectCustomerCandidate("8793", candidates), undefined);
});

test("applies a unique customer selection without losing unrelated draft state", () => {
  const selected = applyCustomerCandidateSelection(draft, candidates, candidates[1]!);
  assert.deepEqual(selected.missingFields, ["问题来源"]);
  assert.deepEqual(selected.workItemIds, ["6168016739", "other-history-id"]);
  assert.match(selected.summary, /已选择客户：8793 SexyCloakRoomSYD/);
  assert.equal(selected.resources, draft.resources);
});

