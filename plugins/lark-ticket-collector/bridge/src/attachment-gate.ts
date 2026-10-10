import type { AgentResult, DraftMemoryUpdate } from "./types.js";

export interface AttachmentGateResult {
  text: string;
  draft: DraftMemoryUpdate;
  blocked: boolean;
}

function fullyVerified(result: AgentResult): boolean {
  const report = result.attachmentArchive;
  return (
    report.status === "verified" &&
    report.expectedBindings > 0 &&
    report.verifiedBindings === report.expectedBindings &&
    report.targets.length > 0 &&
    report.targets.every(
      (target) =>
        target.expectedFiles > 0 && target.verifiedFiles === target.expectedFiles,
    )
  );
}

export function enforceAttachmentCompletion(input: {
  result: AgentResult;
  hasReadableResources: boolean;
}): AttachmentGateResult {
  const { result } = input;
  const hasCommittedWorkItems = result.workItemOutcomes.some(
    (outcome) => outcome.disposition !== "queried",
  );
  if (!input.hasReadableResources || !hasCommittedWorkItems) {
    return { text: result.text, draft: result.draft, blocked: false };
  }

  if (result.attachmentArchive.status === "not_applicable") {
    return { text: result.text, draft: result.draft, blocked: false };
  }
  if (fullyVerified(result)) {
    return { text: result.text, draft: result.draft, blocked: false };
  }

  const report = result.attachmentArchive;
  const missing = Math.max(0, report.expectedBindings - report.verifiedBindings);
  const detail = report.note?.trim()
    ? report.note.trim()
    : `附件回读验证未完成：${report.verifiedBindings}/${report.expectedBindings}`;
  const draft: DraftMemoryUpdate = {
    ...result.draft,
    action: "update",
    missingFields: [
      ...new Set([
        ...result.draft.missingFields,
        `附件归档待重试（缺少 ${missing || "未确认"} 个绑定）`,
      ]),
    ],
  };
  const text = [
    "状态：部分完成。工单已创建或关联，但附件尚未全部写入；请勿重复建单。",
    result.text,
    `附件门禁：已回读验证 ${report.verifiedBindings}/${report.expectedBindings} 个绑定。${detail}`,
    "系统已保留本轮原始附件和工单 ID，后续只重试缺失的附件绑定。",
  ].join("\n\n");
  return { text, draft, blocked: true };
}
