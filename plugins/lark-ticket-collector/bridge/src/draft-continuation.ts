import type {
  DraftMemoryUpdate,
  DraftRouteCorrectionPolicy,
  DraftSnapshot,
} from "./types.js";

const TICKET_TYPE_REFERENCE =
  /(?:t\s*[1-5]|客服工单|阻断性问题|内容维护|内容工单|需求池|客户刷卡机|风控处理)/giu;
const DROPS_CURRENT_ROUTE = /(?:不用|不要|无需|取消|去掉|移除|不建|不创建)/u;
const NAMES_REPLACEMENT = /(?:改成|改为|换成|切换(?:成|为)?|建立|创建|只要|只需|即可)/u;
const CREATED_WITH_WRONG_TYPE =
  /(?:创建|新建|建)(?:错了|错的|得不对)|(?:工单)?类型(?:选|建|创建)?错了|不该(?:创建|新建|建)/u;
const NAMES_T2_AS_CORRECTION =
  /(?:应该|应当)?是\s*(?:一张|一个)?\s*t\s*2(?:\s*工单)?|(?:改成|改为|换成|换为|调整成|调整为)\s*(?:一张|一个)?\s*t\s*2/iu;
const REMOVES_CONTENT_ITEM =
  /(?:删除|移除|取消|作废|关闭|撤销|不要|不用)(?:这张|这个|原来的?|误建的?)?\s*(?:t\s*3\s*)?(?:内容维护|内容工单)/iu;
const EXPLICITLY_STARTS_ANOTHER =
  /(?:另外|另行|重新|再)(?:新建|创建|建)(?:一张|一个)?|(?:新建|创建|建)(?:另一张|另一个|新的)(?:工单|工作项)/u;

export function isDraftRouteCorrection(messageText: string): boolean {
  if (EXPLICITLY_STARTS_ANOTHER.test(messageText)) return false;
  const referencedTypes = messageText.match(TICKET_TYPE_REFERENCE) ?? [];
  return (
    (referencedTypes.length >= 2 &&
      DROPS_CURRENT_ROUTE.test(messageText) &&
      NAMES_REPLACEMENT.test(messageText)) ||
    (CREATED_WITH_WRONG_TYPE.test(messageText) &&
      NAMES_T2_AS_CORRECTION.test(messageText) &&
      REMOVES_CONTENT_ITEM.test(messageText))
  );
}

/**
 * Lock the one high-risk post-creation correction that has caused accidental
 * duplicate bundles in production. Keeping this predicate deliberately narrow
 * prevents ordinary updates, pre-submit route changes, and new-ticket requests
 * from inheriting cleanup instructions.
 */
export function deriveDraftRouteCorrectionPolicy(input: {
  messageText: string;
  activeDraft?: DraftSnapshot;
}): DraftRouteCorrectionPolicy | undefined {
  const { activeDraft, messageText } = input;
  if (
    !activeDraft ||
    activeDraft.workItemIds.length === 0 ||
    !draftIncludesContentMaintenance(activeDraft) ||
    EXPLICITLY_STARTS_ANOTHER.test(messageText) ||
    !CREATED_WITH_WRONG_TYPE.test(messageText) ||
    !NAMES_T2_AS_CORRECTION.test(messageText) ||
    !REMOVES_CONTENT_ITEM.test(messageText)
  ) {
    return undefined;
  }

  return {
    mode: "replace_content_maintenance_with_t2",
    authoritative: true,
    targetCustomerIssueOption: "T2非核心阻断性问题类流转升级",
    targetPairedWorkItemType: "blocking_issue",
    obsoletePairedWorkItemType: "content_maintenance",
    preserveExistingCustomer: true,
    cleanupRequested: true,
    cleanupMode: "detach_then_cancel_if_supported",
  };
}

export function draftIncludesContentMaintenance(
  draft?: Pick<DraftSnapshot, "ticketType" | "summary">,
): boolean {
  return /(?:内容维护|内容工单|T3)/iu.test(
    [draft?.ticketType, draft?.summary].filter(Boolean).join(" "),
  );
}

export function enforceDraftRouteContinuation(input: {
  messageText: string;
  activeDraft?: DraftSnapshot;
  draft: DraftMemoryUpdate;
}): { draft: DraftMemoryUpdate; continued: boolean } {
  if (
    !input.activeDraft ||
    input.draft.action !== "open" ||
    !isDraftRouteCorrection(input.messageText)
  ) {
    return { draft: input.draft, continued: false };
  }
  return {
    draft: { ...input.draft, action: "update" },
    continued: true,
  };
}
