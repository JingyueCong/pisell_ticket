import assert from "node:assert/strict";
import test from "node:test";

import {
  semanticConflicts,
  semanticWritePolicyError,
  semanticWriteText,
} from "../src/semantic-gate.js";
import type { VisualSemanticEvidence } from "../src/types.js";

const evidence: VisualSemanticEvidence = {
  quotes: ["你好 Charlestown明天4:30闭店 麻烦取消下线上订票"],
  confidence: "high",
};

test("semantic gate blocks the Charlestown direction and object rewrite", () => {
  const args = [
    "workitem",
    "create",
    "--name",
    "Charlestown 明天 4:30 闭店，取消线下订单",
    "--fields",
    JSON.stringify([{ field_key: "description", field_value: "请协助取消线下订单" }]),
  ];

  assert.match(semanticWritePolicyError(args, evidence) ?? "", /线上.*线下/);
  assert.match(semanticWritePolicyError(args, evidence) ?? "", /订票.*订单/);
});

test("semantic gate accepts a faithful title and description", () => {
  const args = [
    "workitem",
    "create",
    "--params",
    JSON.stringify({
      name: "Charlestown 明天 4:30 闭店，取消线上订票",
      fields: [
        { field_key: "description", field_value: "商家要求取消线上订票。" },
        { field_key: "field_source", field_value: "线下销售 / 运营转述" },
      ],
    }),
  ];

  assert.equal(semanticWritePolicyError(args, evidence), undefined);
  assert.match(semanticWriteText(args), /取消线上订票/);
  assert.doesNotMatch(semanticWriteText(args), /线下销售/);
});

test("semantic gate ignores reads, relationship writes, and ambiguous source quotes", () => {
  assert.equal(
    semanticWritePolicyError(["workitem", "query", "--name", "线下订单"], evidence),
    undefined,
  );
  assert.equal(
    semanticWritePolicyError(
      [
        "workitem",
        "update",
        "--fields",
        JSON.stringify([{ field_key: "priority", field_value: "线下订单" }]),
      ],
      evidence,
    ),
    undefined,
  );
  assert.deepEqual(
    semanticConflicts({
      evidence: {
        quotes: ["请核实线上与线下订票是否都关闭"],
        confidence: "medium",
      },
      proposedText: "关闭线下订票",
    }),
    [],
  );
});
