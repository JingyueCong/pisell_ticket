import assert from "node:assert/strict";
import test from "node:test";

import {
  contentMaintenanceProducerTarget,
  customerIntakeOwnerTarget,
} from "../src/work-item-outcomes.js";
import type { AgentResult, IntakeRoutePolicy } from "../src/types.js";

function result(
  workItemOutcomes: AgentResult["workItemOutcomes"],
): AgentResult {
  return {
    text: "test",
    draft: {
      action: "update",
      missingFields: [],
      workItemIds: workItemOutcomes.map((outcome) => outcome.workItemId),
    },
    workItemOutcomes,
    attachmentArchive: {
      status: "not_applicable",
      expectedBindings: 0,
      verifiedBindings: 0,
      targets: [],
    },
    diagnostics: [],
  };
}

test("queried customer candidates are never owner-correction targets", () => {
  assert.equal(
    customerIntakeOwnerTarget(
      result([
        { workItemId: "7129489137", role: "customer", disposition: "queried" },
      ]),
    ),
    undefined,
  );
});

test("created and explicitly reused customer work items are owner-correction targets", () => {
  assert.equal(
    customerIntakeOwnerTarget(
      result([
        { workItemId: "7130000001", role: "customer", disposition: "created" },
      ]),
    ),
    "7130000001",
  );
  assert.equal(
    customerIntakeOwnerTarget(
      result([
        { workItemId: "7130000002", role: "customer", disposition: "reused" },
      ]),
    ),
    "7130000002",
  );
});

test("updated customer work items are corrected only when they belong to the active draft", () => {
  const updated = result([
    { workItemId: "7130000005", role: "customer", disposition: "updated" },
  ]);
  assert.equal(customerIntakeOwnerTarget(updated), undefined);
  assert.equal(
    customerIntakeOwnerTarget(updated, ["7130000005"]),
    "7130000005",
  );
});

test("paired and standalone work items never receive customer intake correction", () => {
  assert.equal(
    customerIntakeOwnerTarget(
      result([
        { workItemId: "7130000003", role: "paired", disposition: "created" },
        { workItemId: "7130000004", role: "standalone", disposition: "created" },
      ]),
    ),
    undefined,
  );
});

test("new paired T3 work item receives deterministic producer verification", () => {
  const value = result([
    { workItemId: "7130000010", role: "customer", disposition: "created" },
    { workItemId: "7130000011", role: "paired", disposition: "created" },
  ]);
  const route: IntakeRoutePolicy = {
    mode: "customer_bundle",
    authoritative: true,
    reason: "test",
    pairedWorkItemType: "content_maintenance",
  };
  assert.equal(contentMaintenanceProducerTarget(value, route), "7130000011");
});

test("new standalone content work item receives deterministic producer verification", () => {
  const value = result([
    { workItemId: "7130000012", role: "standalone", disposition: "created" },
  ]);
  const route: IntakeRoutePolicy = {
    mode: "standalone",
    authoritative: true,
    reason: "test",
    standaloneWorkItemType: "content_maintenance",
  };
  assert.equal(contentMaintenanceProducerTarget(value, route), "7130000012");
});

test("reused or queried content work items are not reassigned", () => {
  const route: IntakeRoutePolicy = {
    mode: "customer_bundle",
    authoritative: true,
    reason: "test",
    pairedWorkItemType: "content_maintenance",
  };
  assert.equal(
    contentMaintenanceProducerTarget(
      result([{ workItemId: "7130000013", role: "paired", disposition: "reused" }]),
      route,
    ),
    undefined,
  );
});

test("a persisted single-producer binding identifies T3 on a generic bundle result", () => {
  const value = result([
    { workItemId: "7130000014", role: "customer", disposition: "created" },
    { workItemId: "7130000015", role: "paired", disposition: "created" },
  ]);
  value.draft.ticketType = "customer_bundle";
  assert.equal(
    contentMaintenanceProducerTarget(value, undefined, true),
    "7130000015",
  );
});
