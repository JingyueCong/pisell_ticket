import type { IntakeRoutePolicy, WorkItemOutcome } from "./types.js";

const CUSTOMER_SERVICE_WORK_ITEM_TYPE = "6886d47112cff2ae4ae279e3";
const WORK_ITEM_TYPE_KEYS = {
  blocking_issue: "67df88cf656f61b9b41455d3",
  content_maintenance: "67df87a8baf45c9c247ba778",
  demand_pool: "67ee41797f03010701cea7c6",
  customer_card_machine: "684b899ff9f859147aeca7dd",
  risk_control: "6a7bbb6b50cf1f8304fedf79",
} as const;

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function expectedTypeKey(
  outcome: WorkItemOutcome,
  routePolicy?: IntakeRoutePolicy,
): string | undefined {
  if (outcome.disposition === "queried") return undefined;
  if (outcome.role === "customer") return CUSTOMER_SERVICE_WORK_ITEM_TYPE;
  const type =
    outcome.role === "paired"
      ? routePolicy?.pairedWorkItemType
      : routePolicy?.standaloneWorkItemType;
  return type ? WORK_ITEM_TYPE_KEYS[type] : undefined;
}

/**
 * Rebuild links for committed work items from deterministic route metadata.
 * Agent prose is allowed to choose link labels, but not URL structure/type.
 */
export function normalizeMeegleWorkItemLinks(input: {
  text: string;
  host: string;
  routePolicy?: IntakeRoutePolicy;
  outcomes: WorkItemOutcome[];
}): string {
  const host = input.host
    .trim()
    .replace(/^https?:\/\//iu, "")
    .replace(/\/+$/u, "");
  if (!host) return input.text;

  const typeById = new Map<string, string>();
  for (const outcome of input.outcomes) {
    const typeKey = expectedTypeKey(outcome, input.routePolicy);
    if (typeKey && /^\d+$/u.test(outcome.workItemId)) {
      typeById.set(outcome.workItemId, typeKey);
    }
  }
  if (!typeById.size) return input.text;

  const escapedHost = regexEscape(host);
  const complete = new RegExp(
    `https:\\/\\/${escapedHost}\\/([^\\s/)]+)\\/([^\\s/)]+)\\/detail\\/(\\d+)`,
    "giu",
  );
  const missingType = new RegExp(
    `https:\\/\\/${escapedHost}\\/([^\\s/)]+)\\/detail\\/(\\d+)`,
    "giu",
  );

  const withCorrectTypes = input.text.replace(
    complete,
    (url, projectSegment: string, _currentType: string, workItemId: string) => {
      const typeKey = typeById.get(workItemId);
      return typeKey
        ? `https://${host}/${projectSegment}/${typeKey}/detail/${workItemId}`
        : url;
    },
  );
  return withCorrectTypes.replace(
    missingType,
    (url, projectSegment: string, workItemId: string) => {
      const typeKey = typeById.get(workItemId);
      return typeKey
        ? `https://${host}/${projectSegment}/${typeKey}/detail/${workItemId}`
        : url;
    },
  );
}
