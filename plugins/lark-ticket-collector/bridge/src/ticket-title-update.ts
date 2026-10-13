import type { DraftSnapshot } from "./types.js";

export type TicketTitleTargetType =
  | "customer"
  | "blocking_issue"
  | "content_maintenance";

export type TicketTitleClarificationReason =
  | "missing_title"
  | "title_too_long"
  | "missing_target"
  | "ambiguous_target";

export type TicketTitleUpdatePolicy =
  | {
      authoritative: true;
      mode: "rename_existing_work_item";
      newTitle: string;
      targetMode: "work_item_id" | "single_related_work_item";
      targetWorkItemId: string;
      candidateWorkItemIds: string[];
    }
  | {
      authoritative: true;
      mode: "rename_existing_work_item";
      newTitle: string;
      targetMode: "related_work_item_type";
      targetWorkItemType: TicketTitleTargetType;
      candidateWorkItemIds: string[];
    }
  | {
      authoritative: true;
      mode: "clarify_title_update";
      newTitle?: string;
      targetMode: "clarification";
      candidateWorkItemIds: string[];
      clarificationReason: TicketTitleClarificationReason;
    };

const TITLE_CONTEXT = /(?:标题|title|名字|名称|重命名)/iu;
const RENAME_MARKER =
  /(?:改成|改为|换成|换为|叫做|重命名(?:为|成)|标题(?:调整)?为|名称(?:调整)?为)\s*[：:]?\s*/giu;
const WORK_ITEM_ID = /(?:detail\/|#\s*|工单(?:号|ID)?\s*[#：:]?\s*)(\d{8,})/iu;

function cleanTitle(value: string): string {
  let title = value.trim();
  const pairs: Array<[string, string]> = [
    ["“", "”"],
    ["‘", "’"],
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
  ];
  for (const [left, right] of pairs) {
    if (title.startsWith(left) && title.endsWith(right) && title.length > 1) {
      title = title.slice(left.length, -right.length).trim();
      break;
    }
  }
  return title.replace(/[。；;]\s*$/u, "").trim();
}

function requestedTypes(prefix: string): TicketTitleTargetType[] {
  const types = new Set<TicketTitleTargetType>();
  if (/(?:客服工单|客服单)/u.test(prefix)) types.add("customer");
  if (/(?:t\s*2|阻断性问题|阻断工单)/iu.test(prefix)) {
    types.add("blocking_issue");
  }
  if (/(?:t\s*3|内容维护|内容工单)/iu.test(prefix)) {
    types.add("content_maintenance");
  }
  return [...types];
}

export function isTicketTitleUpdateRequest(messageText: string): boolean {
  if (!TITLE_CONTEXT.test(messageText)) return false;
  RENAME_MARKER.lastIndex = 0;
  return RENAME_MARKER.test(messageText);
}

export function deriveTicketTitleUpdatePolicy(input: {
  messageText: string;
  relatedDraft?: DraftSnapshot;
}): TicketTitleUpdatePolicy | undefined {
  if (!isTicketTitleUpdateRequest(input.messageText)) return undefined;

  RENAME_MARKER.lastIndex = 0;
  const matches = [...input.messageText.matchAll(RENAME_MARKER)];
  const marker = matches.at(-1);
  if (!marker) return undefined;
  const markerIndex = marker.index ?? 0;
  const markerEnd = markerIndex + marker[0].length;
  const prefix = input.messageText.slice(0, markerEnd);
  const newTitle = cleanTitle(input.messageText.slice(markerEnd));
  const candidateWorkItemIds = [
    ...new Set(input.relatedDraft?.workItemIds.filter((id) => /^\d+$/u.test(id)) ?? []),
  ];

  if (!newTitle) {
    return {
      authoritative: true,
      mode: "clarify_title_update",
      targetMode: "clarification",
      candidateWorkItemIds,
      clarificationReason: "missing_title",
    };
  }
  if (newTitle.length > 200) {
    return {
      authoritative: true,
      mode: "clarify_title_update",
      newTitle,
      targetMode: "clarification",
      candidateWorkItemIds,
      clarificationReason: "title_too_long",
    };
  }

  const explicitId = WORK_ITEM_ID.exec(prefix)?.[1];
  if (explicitId) {
    return {
      authoritative: true,
      mode: "rename_existing_work_item",
      newTitle,
      targetMode: "work_item_id",
      targetWorkItemId: explicitId,
      candidateWorkItemIds,
    };
  }

  const types = requestedTypes(prefix);
  if (types.length === 1 && candidateWorkItemIds.length > 0) {
    return {
      authoritative: true,
      mode: "rename_existing_work_item",
      newTitle,
      targetMode: "related_work_item_type",
      targetWorkItemType: types[0]!,
      candidateWorkItemIds,
    };
  }
  if (types.length > 1 || candidateWorkItemIds.length > 1) {
    return {
      authoritative: true,
      mode: "clarify_title_update",
      newTitle,
      targetMode: "clarification",
      candidateWorkItemIds,
      clarificationReason: "ambiguous_target",
    };
  }
  if (candidateWorkItemIds.length === 1) {
    return {
      authoritative: true,
      mode: "rename_existing_work_item",
      newTitle,
      targetMode: "single_related_work_item",
      targetWorkItemId: candidateWorkItemIds[0]!,
      candidateWorkItemIds,
    };
  }
  return {
    authoritative: true,
    mode: "clarify_title_update",
    newTitle,
    targetMode: "clarification",
    candidateWorkItemIds,
    clarificationReason: "missing_target",
  };
}

export function titleUpdateClarification(policy: Extract<
  TicketTitleUpdatePolicy,
  { mode: "clarify_title_update" }
>): string {
  if (policy.clarificationReason === "missing_title") {
    return "请提供新的工单标题，例如：把客服工单标题改为：新版 POS 无法打印小票。";
  }
  if (policy.clarificationReason === "title_too_long") {
    return "新标题超过 200 个字符，请缩短后重新发送完整修改指令。";
  }
  if (policy.clarificationReason === "missing_target") {
    return "请提供工单号或工单链接，例如：修改工单 #7132695930 的标题为：新版 POS 无法打印小票。";
  }
  return [
    "当前消息关联了多张工单，请明确要修改哪一张。",
    "请回复完整指令，例如：",
    "- 客服工单标题改为：新版 POS 无法打印小票",
    "- T2 标题改为：支付成功但没有出单",
    "- 工单 #7132695930 重命名为：新的标题",
  ].join("\n");
}
