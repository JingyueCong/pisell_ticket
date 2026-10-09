import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BridgeConfig } from "../src/config.js";
import {
  isMeegleAuthorizationConfirmation,
  MeegleIdentityManager,
  type ProcessRunner,
} from "../src/meegle-identity.js";

function config(dataDir: string): BridgeConfig {
  return {
    lark: {
      appId: "cli_test",
      appSecret: "secret",
      cliProfile: "lark-admin",
      cliBin: "lark-cli",
      allowedChatIds: [],
      visitRecordChatIds: [],
      visitRecordAllGroups: false,
      allowedSenderIds: [],
      requireMention: true,
    },
    meegleIdentity: {
      enabled: true,
      bin: "meegle",
      host: "project.feishu.cn",
      projectKey: "v2qint",
      profileOverrides: new Map(),
    },
    codex: {
      bin: "codex",
      workspace: "/tmp/workspace",
      timeoutMs: 180_000,
      probeTimeoutMs: 30_000,
    },
    storage: {
      dataDir,
      dbPath: join(dataDir, "bridge.sqlite"),
      resourceDir: join(dataDir, "resources"),
    },
    limits: {
      maxReplyChars: 12_000,
      maxHistoryMessages: 12,
      maxHistoryAgeMs: 30 * 24 * 60 * 60_000,
      draftTtlMs: 7 * 24 * 60 * 60_000,
      maxResourceBytes: 25 * 1024 * 1024,
    },
    health: { host: "127.0.0.1", port: 0 },
  };
}

test("recognizes only explicit Meegle authorization confirmations", () => {
  assert.equal(isMeegleAuthorizationConfirmation("@机器人 已授权"), true);
  assert.equal(isMeegleAuthorizationConfirmation("授权完成"), true);
  assert.equal(isMeegleAuthorizationConfirmation("请帮我创建工单"), false);
});

test("customer intake node owner is force-updated and read back with the verified profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  const calls: string[][] = [];
  let updated = false;
  const runner: ProcessRunner = async (executable, args) => {
    calls.push([executable, ...args]);
    if (args.includes("get-node")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: {
            nodes: [
              {
                name: "创建工单",
                state_key: "started",
                owners: updated
                  ? [{ user_key: "meegle_alice" }]
                  : [{ user_key: "echo" }],
              },
            ],
          },
        }),
        stderr: "",
      };
    }
    if (args.includes("update-node")) updated = true;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };

  try {
    const result = await new MeegleIdentityManager(config(directory), runner)
      .ensureCustomerIntakeNodeOwner({
        identity: {
          profile: "lark-alice",
          userKey: "meegle_alice",
          name: "Alice",
        },
        workItemId: "7130051159",
      });
    assert.deepEqual(result, { nodeId: "started", ownerUserKey: "meegle_alice" });
    const updateCall = calls.find((call) => call.includes("update-node"));
    assert.ok(updateCall);
    assert.equal(updateCall?.[updateCall.indexOf("--profile") + 1], "lark-alice");
    assert.equal(updateCall?.[updateCall.indexOf("--node-owners") + 1], "meegle_alice");
    assert.equal(updateCall?.[updateCall.indexOf("--project-key") + 1], "v2qint");
    assert.equal(calls.filter((call) => call.includes("get-node")).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("per-user authorization binds a verified sender and reuses only that profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  let authenticated = false;
  const calls: string[][] = [];
  const runner: ProcessRunner = async (executable, args) => {
    calls.push([executable, ...args]);
    if (executable === "lark-cli") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: { users: [{ open_id: "ou_alice", localized_name: "Alice" }] },
        }),
        stderr: "",
      };
    }
    if (args.includes("status")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ authenticated }),
        stderr: "",
      };
    }
    if (args.includes("init")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          client_id: "client",
          device_code: "secret-device-code",
          user_code: "ABCD-EFGH",
          verification_uri_complete: "https://project.feishu.cn/auth/device?code=ABCD-EFGH",
          expires_in: 1800,
        }),
        stderr: "",
      };
    }
    if (args.includes("poll")) {
      authenticated = true;
      return { exitCode: 0, stdout: JSON.stringify({ status: "authorization_pending" }), stderr: "" };
    }
    if (args.includes("user") && args.includes("me")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          user_key: "meegle_alice",
          name_en: "Alice",
          email: "alice@pisell.com",
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };

  try {
    const manager = new MeegleIdentityManager(config(directory), runner);
    const initial = await manager.authorize({
      senderId: "ou_alice",
      senderName: "Alice",
      messageText: "创建客服工单",
    });
    assert.equal(initial.kind, "blocked");
    assert.match(initial.kind === "blocked" ? initial.reply : "", /个人授权/);

    const verified = await manager.authorize({
      senderId: "ou_alice",
      senderName: "Alice",
      messageText: "@机器人 已授权",
    });
    assert.equal(verified.kind, "blocked");
    assert.match(verified.kind === "blocked" ? verified.reply : "", /Alice/);

    const allowed = await manager.authorize({
      senderId: "ou_alice",
      senderName: "Alice",
      messageText: "重新发送客服工单",
    });
    assert.equal(allowed.kind, "authorized");
    if (allowed.kind === "authorized") {
      assert.equal(allowed.identity.name, "Alice");
      assert.equal(allowed.identity.userKey, "meegle_alice");
      assert.match(allowed.identity.profile, /^lark-[a-f0-9]{16}$/);
      assert.notEqual(allowed.identity.profile, "default");
    }
    const meegleProfiles = calls
      .filter(([executable]) => executable === "meegle")
      .map((call) => call[call.indexOf("--profile") + 1]);
    assert.equal(new Set(meegleProfiles).size, 1);
    assert.ok(
      calls.filter((call) => call.includes("user") && call.includes("me")).length >= 2,
      "the persisted binding is checked against the current Meegle login on every request",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("authorization is revoked when the Meegle account belongs to another sender", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-identity-"));
  let logoutCalled = false;
  const runner: ProcessRunner = async (executable, args) => {
    if (executable === "lark-cli") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          data: [{ open_id: "ou_bob", name: "Bob", email: "bob@pisell.com" }],
        }),
        stderr: "",
      };
    }
    if (args.includes("status")) {
      return { exitCode: 0, stdout: JSON.stringify({ authenticated: true }), stderr: "" };
    }
    if (args.includes("user") && args.includes("me")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          user_key: "meegle_alice",
          name_en: "Alice",
          email: "alice@pisell.com",
        }),
        stderr: "",
      };
    }
    if (args.includes("logout")) logoutCalled = true;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };

  try {
    const result = await new MeegleIdentityManager(config(directory), runner).authorize({
      senderId: "ou_bob",
      senderName: "Bob",
      messageText: "创建客服工单",
    });
    assert.equal(result.kind, "blocked");
    assert.match(result.kind === "blocked" ? result.reply : "", /不一致/);
    assert.equal(logoutCalled, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
