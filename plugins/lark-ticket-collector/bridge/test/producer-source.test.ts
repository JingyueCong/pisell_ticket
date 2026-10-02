import assert from "node:assert/strict";
import test from "node:test";

import { parseProducerNames } from "../src/producer-source.js";

const config = {
  chatId: "oc_producer",
  extractPattern: "制作\\s*[:：]\\s*(.+?)(?=\\s*确认\\s*[:：]|$)",
  nameSplitPattern: "[/／、,，&＆]+",
};

test("parses and deduplicates producers without including the confirmer", () => {
  assert.deepEqual(
    parseProducerNames(
      "内部任务沟通9.28-9.30 制作：Annie/Jane/annie 确认:Kiddy",
      config,
    ),
    ["Annie", "Jane"],
  );
});

test("returns no producers when the configured label is absent", () => {
  assert.deepEqual(parseProducerNames("内部任务沟通 确认:Kiddy", config), []);
});
