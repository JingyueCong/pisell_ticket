import type { DraftMemoryUpdate, DraftSnapshot } from "./types.js";

const TICKET_TYPE_REFERENCE =
  /(?:t\s*[1-5]|客服工单|阻断性问题|内容维护|内容工单|需求池|客户刷卡机|风控处理)/giu;
const DROPS_CURRENT_ROUTE = /(?:不用|不要|无需|取消|去掉|移除|不建|不创建)/u;
const NAMES_REPLACEMENT = /(?:改成|改为|换成|切换(?:成|为)?|建立|创建|只要|只需|即可)/u;
const EXPLICITLY_STARTS_ANOTHER =
  /(?:另外|另行|重新|再)(?:新建|创建|建)(?:一张|一个)?|(?:新建|创建|建)(?:另一张|另一个|新的)(?:工单|工作项)/u;

export function isDraftRouteCorrection(messageText: string): boolean {
  if (EXPLICITLY_STARTS_ANOTHER.test(messageText)) return false;
  const referencedTypes = messageText.match(TICKET_TYPE_REFERENCE) ?? [];
  return (
    referencedTypes.length >= 2 &&
    DROPS_CURRENT_ROUTE.test(messageText) &&
    NAMES_REPLACEMENT.test(messageText)
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
