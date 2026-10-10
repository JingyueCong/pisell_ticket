import assert from "node:assert/strict";
import test from "node:test";

import { enforceAttachmentCompletion } from "../src/attachment-gate.js";
import type { AgentResult } from "../src/types.js";

function result(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    text: "已创建并关联成功",
    draft: {
      action: "close",
      ticketType: "客服工单 + 内容维护",
      summary: "已创建两张工单",
      missingFields: [],
      workItemIds: ["7131190889", "7131245709"],
    },
    workItemOutcomes: [
      { workItemId: "7131190889", role: "customer", disposition: "created" },
      { workItemId: "7131245709", role: "paired", disposition: "created" },
    ],
    attachmentArchive: {
      status: "failed",
      expectedBindings: 12,
      verifiedBindings: 0,
      targets: [
        {
          workItemId: "7131190889",
          fieldKey: "field_f0d460",
          expectedFiles: 6,
          verifiedFiles: 0,
        },
        {
          workItemId: "7131245709",
          fieldKey: "field_581e1d",
          expectedFiles: 6,
          verifiedFiles: 0,
        },
      ],
      note: "平台结构校验失败",
    },
    diagnostics: [],
    ...overrides,
  };
}

test("attachment failure keeps the draft open and preserves work item ids", () => {
  const gated = enforceAttachmentCompletion({
    result: result(),
    hasReadableResources: true,
  });

  assert.equal(gated.blocked, true);
  assert.equal(gated.draft.action, "update");
  assert.deepEqual(gated.draft.workItemIds, ["7131190889", "7131245709"]);
  assert.match(gated.draft.missingFields.join(" "), /附件归档待重试/);
  assert.match(gated.text, /状态：部分完成/);
  assert.match(gated.text, /0\/12/);
  assert.match(gated.text, /请勿重复建单/);
});

test("all attachment bindings must be verified before close is accepted", () => {
  const verified = result({
    attachmentArchive: {
      status: "verified",
      expectedBindings: 12,
      verifiedBindings: 12,
      targets: [
        {
          workItemId: "7131190889",
          fieldKey: "field_f0d460",
          expectedFiles: 6,
          verifiedFiles: 6,
        },
        {
          workItemId: "7131245709",
          fieldKey: "field_581e1d",
          expectedFiles: 6,
          verifiedFiles: 6,
        },
      ],
    },
  });
  const gated = enforceAttachmentCompletion({
    result: verified,
    hasReadableResources: true,
  });

  assert.equal(gated.blocked, false);
  assert.equal(gated.draft.action, "close");
});

test("a verified label with mismatched counts is rejected", () => {
  const inconsistent = result({
    attachmentArchive: {
      status: "verified",
      expectedBindings: 12,
      verifiedBindings: 11,
      targets: [
        {
          workItemId: "7131190889",
          fieldKey: "field_f0d460",
          expectedFiles: 6,
          verifiedFiles: 6,
        },
        {
          workItemId: "7131245709",
          fieldKey: "field_581e1d",
          expectedFiles: 6,
          verifiedFiles: 5,
        },
      ],
    },
  });
  const gated = enforceAttachmentCompletion({
    result: inconsistent,
    hasReadableResources: true,
  });

  assert.equal(gated.blocked, true);
  assert.equal(gated.draft.action, "update");
});

test("queried duplicate candidates never trigger the attachment completion gate", () => {
  const candidate = result({
    text: "发现重复工单，请确认复用或仍创建",
    draft: {
      action: "update",
      ticketType: "客服工单 + 内容维护",
      summary: "等待重复工单选择",
      missingFields: ["复用或仍创建"],
      workItemIds: ["7129489137"],
    },
    workItemOutcomes: [
      { workItemId: "7129489137", role: "customer", disposition: "queried" },
    ],
    attachmentArchive: {
      status: "pending",
      expectedBindings: 0,
      verifiedBindings: 0,
      targets: [],
    },
  });

  const gated = enforceAttachmentCompletion({
    result: candidate,
    hasReadableResources: true,
  });

  assert.equal(gated.blocked, false);
  assert.equal(gated.text, candidate.text);
  assert.deepEqual(gated.draft, candidate.draft);
});

test("configuration screenshots may be explicitly marked not applicable", () => {
  const notApplicable = result({
    attachmentArchive: {
      status: "not_applicable",
      expectedBindings: 0,
      verifiedBindings: 0,
      targets: [],
      note: "仅用于说明配置，不是业务证据",
    },
  });
  const gated = enforceAttachmentCompletion({
    result: notApplicable,
    hasReadableResources: true,
  });

  assert.equal(gated.blocked, false);
  assert.equal(gated.draft.action, "close");
});
