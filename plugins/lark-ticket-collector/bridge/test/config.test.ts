import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("loadConfig parses allowlists and resolves paths", () => {
  const config = loadConfig({
    LARK_APP_ID: "cli_test",
    LARK_APP_SECRET: "secret",
    LARK_CLI_PROFILE: "cli_test",
    LARK_CLI_BIN: "/opt/bin/lark-cli",
    ALLOWED_CHAT_IDS: "oc_a, oc_b",
    VISIT_RECORD_CHAT_IDS: "oc_visit_a, oc_visit_b",
    AUTO_VISIT_RECORD_GROUPS: "true",
    ALLOWED_SENDER_IDS: "ou_a",
    YOKO_HANDOFF_CHAT_ID: "oc_yoko",
    REQUIRE_MENTION: "false",
    BRIDGE_WORKSPACE: "./workspace",
    BRIDGE_DATA_DIR: "./data",
    BRIDGE_DB_PATH: "./data/test.sqlite",
    BRIDGE_RESOURCE_DIR: "./data/resources",
    PER_USER_MEEGLE_AUTH: "true",
    MEEGLE_BIN: "/opt/bin/meegle",
    MEEGLE_PROJECT_KEY: "pisell",
    MEEGLE_PROFILE_OVERRIDES: "ou_a=default,ou_b=ticket-bob",
    HEALTH_PORT: "0",
  });

  assert.deepEqual(config.lark.allowedChatIds, ["oc_a", "oc_b"]);
  assert.deepEqual(config.lark.visitRecordChatIds, ["oc_visit_a", "oc_visit_b"]);
  assert.equal(config.lark.visitRecordAllGroups, true);
  assert.deepEqual(config.lark.allowedSenderIds, ["ou_a"]);
  assert.equal(config.lark.requireMention, false);
  assert.equal(config.lark.cliBin, "/opt/bin/lark-cli");
  assert.equal(config.lark.handoffChatId, "oc_yoko");
  assert.equal(config.health.port, 0);
  assert.equal(config.codex.timeoutMs, 600_000);
  assert.equal(config.codex.probeTimeoutMs, 30_000);
  assert.equal(config.meegleIdentity.enabled, true);
  assert.equal(config.meegleIdentity.bin, "/opt/bin/meegle");
  assert.equal(config.meegleIdentity.projectKey, "pisell");
  assert.equal(config.meegleIdentity.profileOverrides.get("ou_a"), "default");
  assert.equal(config.meegleIdentity.profileOverrides.get("ou_b"), "ticket-bob");
  assert.equal(config.limits.maxHistoryMessages, 12);
  assert.equal(config.limits.maxHistoryAgeMs, 30 * 24 * 60 * 60_000);
  assert.equal(config.limits.draftTtlMs, 7 * 24 * 60 * 60_000);
  assert.match(config.codex.workspace, /workspace$/);
});

test("loadConfig combines producer env id with runtime parsing rules", () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-bridge-config-"));
  const workspace = join(directory, "workspace");
  const configuration = join(workspace, ".ticket-collector", "configuration");
  mkdirSync(configuration, { recursive: true });
  writeFileSync(
    join(configuration, "runtime.json"),
    JSON.stringify({
      content_maintenance: {
        producer_role_source: {
          source_chat_id_env: "CONTENT_PRODUCER_SOURCE_CHAT_ID",
          extract_pattern: "制作\\s*[:：]\\s*(.+?)(?=\\s*确认\\s*[:：]|$)",
          name_split_pattern: "[/／、,，&＆]+",
        },
      },
    }),
  );

  try {
    const config = loadConfig({
      LARK_APP_ID: "cli_test",
      LARK_APP_SECRET: "secret",
      CONTENT_PRODUCER_SOURCE_CHAT_ID: "oc_producer",
      BRIDGE_WORKSPACE: workspace,
      HEALTH_PORT: "0",
    });
    assert.deepEqual(config.lark.contentMaintenanceProducerSource, {
      chatId: "oc_producer",
      extractPattern: "制作\\s*[:：]\\s*(.+?)(?=\\s*确认\\s*[:：]|$)",
      nameSplitPattern: "[/／、,，&＆]+",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("loadConfig disables optional target features when their env vars are empty", () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-bridge-config-"));
  const workspace = join(directory, "workspace");
  const configuration = join(workspace, ".ticket-collector", "configuration");
  mkdirSync(configuration, { recursive: true });
  writeFileSync(
    join(configuration, "runtime.json"),
    JSON.stringify({
      content_maintenance: {
        producer_role_source: {
          source_chat_id_env: "CONTENT_PRODUCER_SOURCE_CHAT_ID",
          extract_pattern: "制作\\s*[:：]\\s*(.+?)(?=\\s*确认\\s*[:：]|$)",
          name_split_pattern: "[/／、,，&＆]+",
        },
      },
    }),
  );

  try {
    const config = loadConfig({
      LARK_APP_ID: "cli_test",
      LARK_APP_SECRET: "secret",
      BRIDGE_WORKSPACE: workspace,
      HEALTH_PORT: "0",
    });
    assert.equal(config.lark.contentMaintenanceProducerSource, undefined);
    assert.equal(config.lark.handoffChatId, undefined);
    assert.deepEqual(config.lark.visitRecordChatIds, []);
    assert.equal(config.lark.visitRecordAllGroups, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
