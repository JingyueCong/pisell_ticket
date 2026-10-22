import type { DraftSnapshot } from "./types.js";

const DUPLICATE_SELECTION_FIELD =
  /(?:重复|相似)(?:工单)?(?:候选)?[^。；\n]{0,12}(?:处理)?选择|仍创建或复用|复用或仍创建/iu;
const CREATE_NEW_SELECTION =
  /(?:^|[，,；;。\s])(?:仍|继续|重新)?\s*(?:创建|新建)(?:\s*(?:独立)?工单)?(?:$|[，,；;。\s])|(?:不|无需|不要)\s*(?:复用|使用)(?:历史|已有|相似|重复)?(?:工单|候选)?|忽略(?:相似|重复)(?:工单|候选)?/iu;

export function isDuplicateSelectionField(field: string): boolean {
  return DUPLICATE_SELECTION_FIELD.test(field.trim());
}

export function draftNeedsDuplicateSelection(
  draft?: Pick<DraftSnapshot, "missingFields">,
): boolean {
  return Boolean(
    draft?.missingFields.some((field) => isDuplicateSelectionField(field)),
  );
}

export function employeeSelectedCreateNew(input: {
  messageText: string;
  activeDraft?: Pick<DraftSnapshot, "missingFields">;
}): boolean {
  return (
    draftNeedsDuplicateSelection(input.activeDraft) &&
    CREATE_NEW_SELECTION.test(input.messageText.normalize("NFKC"))
  );
}

/**
 * Resolve an explicit duplicate decision in the trusted draft context before
 * the agent runs. This prevents a short reply such as “仍创建” or “重新创建”
 * from being mistaken for a fresh, empty ticket request.
 */
export function applyCreateNewDuplicateSelection(
  draft: DraftSnapshot,
): DraftSnapshot {
  const resolution = "相似/重复候选处理选择：仍创建独立工单，不复用历史候选";
  return {
    ...draft,
    summary: draft.summary.includes(resolution)
      ? draft.summary
      : `${draft.summary.replace(/[；;\s]+$/u, "")}；${resolution}`,
    missingFields: draft.missingFields.filter(
      (field) => !isDuplicateSelectionField(field),
    ),
    // While this field is missing, workItemIds are the read-only duplicate
    // candidates returned by the lookup. “Create new” must not carry those IDs
    // forward as if they were part of the new ticket bundle.
    workItemIds: [],
  };
}
