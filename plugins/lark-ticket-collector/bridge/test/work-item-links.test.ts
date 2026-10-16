import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMeegleWorkItemLinks } from "../src/work-item-links.js";

test("repairs a missing customer work-item type without changing the paired link", () => {
  const text = [
    "[客服工单 #7137585659](https://project.feishu.cn/67c68170af5c921068953f8b/detail/7137585659)",
    "[内容维护 #7137623595](https://project.feishu.cn/67c68170af5c921068953f8b/67df87a8baf45c9c247ba778/detail/7137623595)",
  ].join("\n");

  const normalized = normalizeMeegleWorkItemLinks({
    text,
    host: "project.feishu.cn",
    routePolicy: {
      mode: "customer_bundle",
      authoritative: true,
      reason: "test",
      pairedWorkItemType: "content_maintenance",
    },
    outcomes: [
      { workItemId: "7137585659", role: "customer", disposition: "created" },
      { workItemId: "7137623595", role: "paired", disposition: "created" },
    ],
  });

  assert.match(
    normalized,
    /6886d47112cff2ae4ae279e3\/detail\/7137585659/u,
  );
  assert.match(
    normalized,
    /67df87a8baf45c9c247ba778\/detail\/7137623595/u,
  );
  assert.doesNotMatch(normalized, /953f8b\/detail\/7137585659/u);
});

test("corrects a wrong committed type but leaves queried and unrelated links alone", () => {
  const queried = "7137000001";
  const unrelated = "7137000002";
  const normalized = normalizeMeegleWorkItemLinks({
    text: [
      "https://project.feishu.cn/v2qint/wrong/detail/7137000000",
      `https://project.feishu.cn/v2qint/detail/${queried}`,
      `https://project.feishu.cn/v2qint/detail/${unrelated}`,
    ].join("\n"),
    host: "https://project.feishu.cn/",
    routePolicy: {
      mode: "customer_bundle",
      authoritative: true,
      reason: "test",
      pairedWorkItemType: "blocking_issue",
    },
    outcomes: [
      { workItemId: "7137000000", role: "paired", disposition: "created" },
      { workItemId: queried, role: "customer", disposition: "queried" },
    ],
  });

  assert.match(normalized, /67df88cf656f61b9b41455d3\/detail\/7137000000/u);
  assert.match(normalized, new RegExp(`/detail/${queried}$`, "mu"));
  assert.match(normalized, new RegExp(`/detail/${unrelated}$`, "mu"));
});
