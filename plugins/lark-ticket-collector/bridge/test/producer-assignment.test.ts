import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveExplicitProducer,
  resolveTrustedProducerSelection,
} from "../src/producer-assignment.js";

const roster = ["Annie", "Penn", "Joy"];

test("explicit producer in employee text overrides rotation case-insensitively", () => {
  assert.deepEqual(
    resolveExplicitProducer("创建T3工单 负责人penn 无需确认人", roster),
    { producerName: "Penn" },
  );
  assert.deepEqual(resolveExplicitProducer("这个直接安排给 Joy", roster), {
    producerName: "Joy",
  });
  assert.deepEqual(resolveExplicitProducer("Annie 来负责制作", roster), {
    producerName: "Annie",
  });
});

test("generic producer questions do not look like assignments", () => {
  assert.deepEqual(
    resolveExplicitProducer("制作人能不能设置优先指派，没有指派再轮班", roster),
    {},
  );
});

test("unknown or multiple explicit producers are rejected instead of rotating", () => {
  assert.match(
    resolveExplicitProducer("制作人：Mika", roster).error ?? "",
    /not in the trusted roster/,
  );
  assert.match(
    resolveExplicitProducer("安排给 Annie 和 Joy", roster).error ?? "",
    /multiple producers/,
  );
});

test("attachment producer selection is accepted only from the trusted roster", () => {
  const source = {
    chatId: "oc_producers",
    producerNames: ["Annie"],
    producerRoster: roster,
    confirmerNames: [],
    selectionMode: "round_robin_single" as const,
    fetchedAt: 1,
  };
  assert.deepEqual(
    resolveTrustedProducerSelection({
      source,
      reported: { producerName: "penn", source: "attachment_evidence" },
    }),
    { producerName: "Penn", selectionMode: "explicit_single" },
  );
  assert.match(
    resolveTrustedProducerSelection({
      source,
      reported: { producerName: "Mika", source: "attachment_evidence" },
    }).error ?? "",
    /not in the trusted roster/,
  );
});

test("trusted default cannot silently replace the bridge rotation", () => {
  const resolution = resolveTrustedProducerSelection({
    source: {
      chatId: "oc_producers",
      producerNames: ["Annie"],
      producerRoster: roster,
      confirmerNames: [],
      selectionMode: "round_robin_single",
      fetchedAt: 1,
    },
    reported: { producerName: "Joy", source: "trusted_default" },
  });
  assert.match(resolution.error ?? "", /conflicts with the bridge rotation/);
});

