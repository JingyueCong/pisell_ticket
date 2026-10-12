import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { MeegleBrokerSession } from "../src/meegle-broker.js";

const wrapper = resolve("bin/meegle");

async function invoke(args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "meegle-wrapper-"));
  const real = join(directory, "meegle-real");
  const brokerDirectory = join(directory, "broker");
  writeFileSync(real, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o700 });
  chmodSync(real, 0o700);
  const broker = new MeegleBrokerSession({
    directory: brokerDirectory,
    binary: real,
    profile: "lark-alice",
    commandTimeoutMs: 5_000,
  });
  await broker.prepare();
  const brokerLoop = broker.run();
  try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolveResult, reject) => {
        const child = spawn(wrapper, args, {
          env: {
            ...process.env,
            MEEGLE_BROKER_DIR: brokerDirectory,
            MEEGLE_BROKER_TOKEN: broker.capability.token,
            MEEGLE_BROKER_TIMEOUT_MS: "5000",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => (stdout += chunk));
        child.stderr.on("data", (chunk: string) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (status) => resolveResult({ status, stdout, stderr }));
      },
    );
    return { ...result, audit: broker.audit.map((entry) => ({ ...entry })) };
  } finally {
    broker.stop();
    await brokerLoop;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("wrapper rejects Agent attachment uploads", async () => {
  const result = await invoke(["attachment", "+upload", "/tmp/evidence.png"]);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /managed by the ticket bridge/);
});

test("wrapper rejects Agent multi-file field writes", async () => {
  const result = await invoke([
    "workitem",
    "update",
    "--params",
    JSON.stringify({
      fields: [
        {
          field_key: "field_files",
          field_value: JSON.stringify([
            { name: "a.png", type: "image/png", size: "1", fileToken: "token" },
          ]),
        },
      ],
    }),
  ]);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /attachment field writes/);
});

test("wrapper rejects Agent owner mutation but permits ordinary field updates", async () => {
  const denied = await invoke([
    "workflow",
    "update-node",
    "--params",
    JSON.stringify({ node_owners: ["alice"] }),
  ]);
  assert.equal(denied.status, 64);
  assert.match(denied.stderr, /owner writes/);

  const allowed = await invoke([
    "workitem",
    "update",
    "--params",
    JSON.stringify({ fields: [{ field_key: "priority", field_value: "P1" }] }),
  ]);
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /--profile\nlark-alice\nworkitem\nupdate/);
  assert.deepEqual(allowed.audit, [
    {
      tool: "meegle",
      operation: "workitem update",
      exitCode: 0,
      policyDenied: false,
    },
  ]);
});

test("wrapper cannot change profile, authentication, or CLI configuration", async () => {
  for (const args of [
    ["--profile", "default", "auth", "status"],
    ["auth", "logout"],
    ["config", "set", "host", "example.invalid"],
  ]) {
    const result = await invoke(args);
    assert.equal(result.status, 64);
    assert.equal(result.audit[0]?.policyDenied, true);
  }
});
