import type {
  CustomerCrmCandidate,
  DraftSnapshot,
} from "./types.js";

const CUSTOMER_FIELD = /客户管理|客户\s*[\/／]\s*店铺|客户或店铺|CRM/iu;

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replaceAll(/[\s\p{P}\p{S}]+/gu, "");
}

export function draftNeedsCustomerResolution(
  draft?: Pick<DraftSnapshot, "missingFields" | "workItemIds">,
): boolean {
  return Boolean(
    draft &&
      draft.workItemIds.length > 0 &&
      draft.missingFields.some((field) => CUSTOMER_FIELD.test(field)),
  );
}

export function selectCustomerCandidate(
  message: string,
  candidates: CustomerCrmCandidate[],
): CustomerCrmCandidate | undefined {
  if (candidates.length < 2) return candidates.length === 1 ? candidates[0] : undefined;
  const text = message.normalize("NFKC").trim();
  if (!text) return undefined;

  const exactId = candidates.filter((candidate) =>
    new RegExp(`(?:^|\\D)${candidate.workItemId}(?:\\D|$)`, "u").test(text),
  );
  if (exactId.length === 1) return exactId[0];

  const ordinalPatterns = [
    /^(?:选\s*)?(?:第\s*)?(?:一|1)(?:\s*(?:个|项|条|号))?$/u,
    /^(?:选\s*)?(?:第\s*)?(?:二|2)(?:\s*(?:个|项|条|号))?$/u,
    /^(?:选\s*)?(?:第\s*)?(?:三|3)(?:\s*(?:个|项|条|号))?$/u,
  ];
  const ordinal = ordinalPatterns.findIndex((pattern) => pattern.test(text));
  if (ordinal >= 0) return candidates[ordinal];

  const compact = normalized(text);
  const fullNameMatches = candidates.filter((candidate) => {
    const name = normalized(candidate.name);
    return compact.length >= 2 && (name.includes(compact) || compact.includes(name));
  });
  if (fullNameMatches.length === 1) return fullNameMatches[0];

  const tokenMatches = new Set<number>();
  const messageTokens =
    text.toLocaleLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? [];
  for (const token of messageTokens) {
    const needle = normalized(token);
    if (needle.length < 2 || /^\d+$/u.test(needle)) continue;
    const owners = candidates
      .map((candidate, index) =>
        normalized(candidate.name).includes(needle) ? index : -1,
      )
      .filter((index) => index >= 0);
    if (owners.length === 1) tokenMatches.add(owners[0]!);
  }
  return tokenMatches.size === 1 ? candidates[[...tokenMatches][0]!] : undefined;
}

export function applyCustomerCandidateSelection(
  draft: DraftSnapshot,
  candidates: CustomerCrmCandidate[],
  selected: CustomerCrmCandidate,
): DraftSnapshot {
  const candidateIds = new Set(candidates.map((candidate) => candidate.workItemId));
  const workItemIds = draft.workItemIds.filter(
    (workItemId) => !candidateIds.has(workItemId) || workItemId === selected.workItemId,
  );
  if (!workItemIds.includes(selected.workItemId)) workItemIds.push(selected.workItemId);
  const selection = `已选择客户：${selected.name}（CRM #${selected.workItemId}）`;
  return {
    ...draft,
    summary: draft.summary.includes(selection)
      ? draft.summary
      : `${draft.summary.replace(/[；;\s]+$/u, "")}；${selection}`,
    missingFields: draft.missingFields.filter((field) => !CUSTOMER_FIELD.test(field)),
    workItemIds,
  };
}
