import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { runMaintenance } from "../src/maintenance.js";
import { BridgeStore } from "../src/store.js";

test("maintenance removes old completed resources but preserves open-draft attachments", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-maintenance-"));
  const resources = join(directory, "resources");
  const keepDirectory = join(resources, "om_keep");
  const removeDirectory = join(resources, "om_remove");
  mkdirSync(keepDirectory, { recursive: true });
  mkdirSync(removeDirectory, { recursive: true });
  const keepPath = join(keepDirectory, "keep.png");
  const removePath = join(removeDirectory, "remove.png");
  writeFileSync(keepPath, "keep");
  writeFileSync(removePath, "remove");
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  const config = loadConfig({
    LARK_APP_ID: "cli_test",
    LARK_APP_SECRET: "secret",
    BRIDGE_WORKSPACE: directory,
    BRIDGE_DATA_DIR: directory,
    BRIDGE_DB_PATH: join(directory, "bridge.sqlite"),
    BRIDGE_RESOURCE_DIR: resources,
    RESOURCE_RETENTION_DAYS: "1",
    AUDIT_RETENTION_DAYS: "180",
    HEALTH_PORT: "0",
  });
  try {
    store.saveResources("om_keep", [{ type: "image", fileKey: "keep", localPath: keepPath }]);
    store.saveResources("om_remove", [{ type: "image", fileKey: "remove", localPath: removePath }]);
    store.applyDraftUpdate({
      conversationKey: "oc:ou:om_keep",
      chatId: "oc",
      senderId: "ou",
      update: { action: "open", summary: "waiting", missingFields: ["店铺"], workItemIds: [] },
      resources: [{ type: "image", fileKey: "keep", localPath: keepPath }],
      ttlMs: 10 * 24 * 60 * 60_000,
    });
    const result = await runMaintenance({
      config,
      store,
      now: Date.now() + 2 * 24 * 60 * 60_000,
    });
    assert.equal(existsSync(keepPath), true);
    assert.equal(existsSync(removePath), false);
    assert.equal(result.deletedFiles, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
