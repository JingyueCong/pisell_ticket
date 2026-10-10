import type { AgentResult } from "./types.js";

export function customerIntakeOwnerTarget(
  result: AgentResult,
  activeDraftWorkItemIds: string[] = [],
): string | undefined {
  const draftIds = new Set(activeDraftWorkItemIds);
  return result.workItemOutcomes.find(
    (outcome) =>
      outcome.role === "customer" &&
      (outcome.disposition === "created" ||
        outcome.disposition === "reused" ||
        (outcome.disposition === "updated" && draftIds.has(outcome.workItemId))),
  )?.workItemId;
}
