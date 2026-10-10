import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BridgeConfig } from "../src/config.js";
import {
  extractAttachmentField,
  extractRawAttachmentField,
  MeegleAttachmentArchiver,
  normalizeUploadedAttachment,
  type AttachmentProcessRunner,
} from "../src/meegle-attachment-archiver.js";

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
      opsAlertCooldownMs: 300_000,
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
      probeIntervalMs: 1_800_000,
      probeFailureThreshold: 2,
      maxConcurrentRuns: 2,
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
    internalApi: { enabled: false },
    maintenance: {
      resourceRetentionMs: 30 * 24 * 60 * 60_000,
      auditRetentionMs: 180 * 24 * 60 * 60_000,
      intervalMs: 60 * 60_000,
    },
  };
}

const identity = {
  profile: "lark-pearl",
  userKey: "meegle_pearl",
  name: "Pearl",
};

test("upload metadata is reduced to the exact Meegle multi-file descriptor", () => {
  const normalized = normalizeUploadedAttachment({
    file_token: "token-1",
    file_url: "https://example.invalid/private",
    name: "proof.png",
    size: 321,
    mime_type: "image/png",
    id: "must-not-leak",
  });
  assert.deepEqual(normalized, {
    name: "proof.png",
    type: "image/png",
    size: "321",
    fileToken: "token-1",
  });
  assert.deepEqual(Object.keys(normalized), ["name", "type", "size", "fileToken"]);
});

test("field extraction accepts object and JSON-string response shapes", () => {
  assert.deepEqual(
    extractAttachmentField(
      {
        data: {
          workitem_fields: [
            {
              field_key: "field_files",
              field_value: JSON.stringify([
                { name: "old.png", type: "image/png", size: "10", fileToken: "old" },
              ]),
            },
          ],
        },
      },
      "field_files",
    ),
    [{ name: "old.png", type: "image/png", size: "10", fileToken: "old" }],
  );
  assert.deepEqual(
    extractAttachmentField(
      {
        data: {
          fields: {
            field_files: [
              { name: "nested.png", type: "image/png", size: 12, file_token: "nested" },
            ],
          },
        },
      },
      "field_files",
    ),
    [{ name: "nested.png", type: "image/png", size: "12", fileToken: "nested" }],
  );
  assert.deepEqual(
    extractRawAttachmentField(
      {
        fields: {
          field_files: [
            {
              name: "server.png",
              type: "image/png",
              size: "30",
              fileToken: "server-token",
              uid: "must-be-preserved",
              url: "https://server.invalid/opaque",
            },
          ],
        },
      },
      "field_files",
    )[0],
    {
      name: "server.png",
      type: "image/png",
      size: "30",
      fileToken: "server-token",
      uid: "must-be-preserved",
      url: "https://server.invalid/opaque",
    },
  );
});

test("archiver appends one file at a time, preserves old values, and verifies each write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-attachments-"));
  const calls: string[][] = [];
  let stored: Array<Record<string, unknown>> = [
    {
      name: "old.pdf",
      type: "application/pdf",
      size: "8",
      fileToken: "old-token",
      uid: "server-uid",
      url: "https://server.invalid/opaque",
    },
  ];
  const runner: AttachmentProcessRunner = async (executable, args) => {
    calls.push([executable, ...args]);
    if (args.includes("+upload")) {
      const path = args[args.indexOf("+upload") + 1] ?? "";
      const second = path.endsWith("02.png");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          file_token: second ? "new-2" : "new-1",
          file_url: "https://must-not-be-written.invalid/file",
          name: second ? "02.png" : "01.png",
          size: second ? 22 : 11,
          mime_type: "image/png",
        }),
        stderr: "",
      };
    }
    if (args.includes("update")) {
      const params = JSON.parse(args[args.indexOf("--params") + 1] ?? "{}") as {
        fields: Array<{ field_key: string; field_value: unknown }>;
      };
      assert.equal(params.fields.length, 1);
      assert.equal(params.fields[0]?.field_key, "field_files");
      assert.equal(typeof params.fields[0]?.field_value, "string");
      stored = JSON.parse(params.fields[0]?.field_value as string) as typeof stored;
      const additions = stored.filter((descriptor) =>
        String(descriptor.fileToken).startsWith("new-"),
      );
      for (const descriptor of additions) {
        assert.deepEqual(Object.keys(descriptor), ["name", "type", "size", "fileToken"]);
        assert.equal(typeof descriptor.size, "string");
      }
      assert.equal(stored[0]?.uid, "server-uid");
      assert.equal(stored[0]?.url, "https://server.invalid/opaque");
      return { exitCode: 0, stdout: "{}", stderr: "" };
    }
    return {
      exitCode: 0,
      stdout: JSON.stringify({ fields: { field_files: stored } }),
      stderr: "",
    };
  };

  try {
    const result = await new MeegleAttachmentArchiver(config(directory), runner).archive({
      identity,
      targets: [{ workItemId: "713", fieldKey: "field_files", expectedFiles: 2, verifiedFiles: 0 }],
      resources: [
        { type: "image", fileKey: "a", fileName: "01.png", localPath: "/tmp/01.png", size: 11, sha256: "a" },
        { type: "image", fileKey: "b", fileName: "02.png", localPath: "/tmp/02.png", size: 22, sha256: "b" },
      ],
      workItemOutcomes: [{ workItemId: "713", role: "customer", disposition: "created" }],
    });
    assert.equal(result.status, "verified");
    assert.equal(result.expectedBindings, 2);
    assert.equal(result.verifiedBindings, 2);
    assert.equal(calls.filter((call) => call.includes("+upload")).length, 2);
    assert.equal(calls.filter((call) => call.includes("update")).length, 2);
    assert.equal(stored.length, 3);
    assert.ok(calls.every((call) => call[call.indexOf("--profile") + 1] === "lark-pearl"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed readback retries the merge without uploading the files again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-attachments-"));
  let updateCount = 0;
  let stored: Array<Record<string, string>> = [];
  let uploadCount = 0;
  const runner: AttachmentProcessRunner = async (_executable, args) => {
    if (args.includes("+upload")) {
      uploadCount += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          file_token: "new-1",
          file_url: "ignored",
          name: "01.png",
          size: 11,
          mime_type: "image/png",
        }),
        stderr: "",
      };
    }
    if (args.includes("update")) {
      updateCount += 1;
      const params = JSON.parse(args[args.indexOf("--params") + 1] ?? "{}") as {
        fields: Array<{ field_value: string }>;
      };
      if (updateCount === 2) stored = JSON.parse(params.fields[0]!.field_value) as typeof stored;
      return { exitCode: 0, stdout: "{}", stderr: "" };
    }
    return { exitCode: 0, stdout: JSON.stringify({ fields: { field_files: stored } }), stderr: "" };
  };

  try {
    const result = await new MeegleAttachmentArchiver(config(directory), runner).archive({
      identity,
      targets: [{ workItemId: "713", fieldKey: "field_files", expectedFiles: 1, verifiedFiles: 0 }],
      resources: [
        { type: "image", fileKey: "a", fileName: "01.png", localPath: "/tmp/01.png", size: 11 },
      ],
      workItemOutcomes: [{ workItemId: "713", role: "customer", disposition: "created" }],
    });
    assert.equal(result.status, "verified");
    assert.equal(updateCount, 2);
    assert.equal(uploadCount, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("queried duplicate candidates are never mutated", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-attachments-"));
  let called = false;
  const runner: AttachmentProcessRunner = async () => {
    called = true;
    return { exitCode: 0, stdout: "{}", stderr: "" };
  };
  try {
    const result = await new MeegleAttachmentArchiver(config(directory), runner).archive({
      identity,
      targets: [{ workItemId: "candidate", fieldKey: "field_files", expectedFiles: 1, verifiedFiles: 0 }],
      resources: [
        { type: "image", fileKey: "a", fileName: "01.png", localPath: "/tmp/01.png", size: 11 },
      ],
      workItemOutcomes: [{ workItemId: "candidate", role: "customer", disposition: "queried" }],
    });
    assert.equal(result.status, "pending");
    assert.equal(called, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
