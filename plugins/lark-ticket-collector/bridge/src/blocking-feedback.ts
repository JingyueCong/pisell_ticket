import type {
  BlockingFeedbackPolicy,
  BlockingFeedbackType,
  DraftSnapshot,
  IntakeRoutePolicy,
} from "./types.js";

const KNOWN_MERCHANT_CHANNEL =
  /企业微信|企微(?:群)?|WhatsApp|客服(?:专用)?邮箱|飞书商家群|Zendesk|线下销售\s*[\/／]\s*运营转述|线下销售|运营转述/iu;
const BLOCKING_DRAFT = /(?:T\s*[12]|(?:核心|非核心)?阻断|阻断性问题|T\s*-?\s*BUG)/iu;
const NEGATION_BEFORE = /(?:不是|并非|不属于|不用|不要|无需|取消|排除|别|没有(?:再|写|填|选)?|无)\s*$/u;
const EXPLICIT_ASSIGNMENT_BEFORE =
  /(?:改成|改为|换成|换为|应为|选择|填写?|反馈类型(?:是|用|按)?|这是|属于|按|用|是)\s*$/u;

interface FeedbackMention {
  feedbackType: BlockingFeedbackType;
  index: number;
  explicitlyAssigned: boolean;
}

function explicitFeedbackType(text: string): BlockingFeedbackType | undefined {
  const mentions: FeedbackMention[] = [];
  for (const feedbackType of ["内部发现", "商家反馈"] as const) {
    let offset = 0;
    while (offset < text.length) {
      const index = text.indexOf(feedbackType, offset);
      if (index < 0) break;
      const before = text.slice(Math.max(0, index - 16), index);
      if (!NEGATION_BEFORE.test(before)) {
        mentions.push({
          feedbackType,
          index,
          explicitlyAssigned: EXPLICIT_ASSIGNMENT_BEFORE.test(before),
        });
      }
      offset = index + feedbackType.length;
    }
  }
  if (!mentions.length) return undefined;
  const distinct = new Set(mentions.map((mention) => mention.feedbackType));
  if (distinct.size === 1) return mentions.at(-1)?.feedbackType;

  // When both labels are merely discussed, do not guess.  A correction such as
  // "商家反馈改成内部发现" is still deterministic because the target label
  // immediately follows an assignment/correction phrase.
  return mentions
    .filter((mention) => mention.explicitlyAssigned)
    .sort((left, right) => left.index - right.index)
    .at(-1)?.feedbackType;
}

export function shouldApplyBlockingFeedbackPolicy(input: {
  routePolicy?: IntakeRoutePolicy;
  activeDraft?: DraftSnapshot;
}): boolean {
  const route = input.routePolicy;
  if (
    route?.pairedWorkItemType === "blocking_issue" ||
    route?.standaloneWorkItemType === "blocking_issue" ||
    route?.mode === "customer_auto"
  ) {
    return true;
  }
  return BLOCKING_DRAFT.test(
    [input.activeDraft?.ticketType, input.activeDraft?.summary]
      .filter(Boolean)
      .join("\n"),
  );
}

export function deriveBlockingFeedbackPolicy(input: {
  currentText: string;
  priorUserTexts?: string[];
}): BlockingFeedbackPolicy {
  const current = explicitFeedbackType(input.currentText);
  if (current) {
    return {
      feedbackType: current,
      authoritative: true,
      source: "employee_explicit_current",
      internalDiscoverer:
        current === "内部发现" ? "verified_submitter" : "omit",
    };
  }

  const priorTexts = input.priorUserTexts ?? [];
  for (const text of [...priorTexts].reverse()) {
    const prior = explicitFeedbackType(text);
    if (prior) {
      return {
        feedbackType: prior,
        authoritative: true,
        source: "employee_explicit_draft_context",
        internalDiscoverer:
          prior === "内部发现" ? "verified_submitter" : "omit",
      };
    }
  }

  if (KNOWN_MERCHANT_CHANNEL.test([input.currentText, ...priorTexts].join("\n"))) {
    return {
      feedbackType: "商家反馈",
      authoritative: true,
      source: "known_merchant_channel",
      internalDiscoverer: "omit",
    };
  }

  return {
    feedbackType: "商家反馈",
    authoritative: true,
    source: "default_merchant",
    internalDiscoverer: "omit",
  };
}
