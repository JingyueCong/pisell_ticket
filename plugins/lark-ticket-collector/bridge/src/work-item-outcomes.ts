import type { AgentResult, IntakeRoutePolicy } from "./types.js";

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

export function contentMaintenanceProducerTarget(
  result: AgentResult,
  routePolicy?: IntakeRoutePolicy,
  contentExpected = false,
): string | undefined {
  const expectedRole =
    routePolicy?.pairedWorkItemType === "content_maintenance"
      ? "paired"
      : routePolicy?.standaloneWorkItemType === "content_maintenance"
        ? "standalone"
        : undefined;
  if (expectedRole) {
    return result.workItemOutcomes.find(
      (outcome) =>
        outcome.role === expectedRole && outcome.disposition === "created",
    )?.workItemId;
  }
  if (
    !contentExpected &&
    !/(?:内容维护|T3)/iu.test(result.draft.ticketType ?? "")
  ) return undefined;
  const created = result.workItemOutcomes.filter(
    (outcome) => outcome.role !== "customer" && outcome.disposition === "created",
  );
  return created.length === 1 ? created[0]?.workItemId : undefined;
}
