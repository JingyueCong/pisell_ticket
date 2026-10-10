import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const wrapper = resolve("bin/meegle");

function invoke(args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "meegle-wrapper-"));
  const real = join(directory, "meegle-real");
  writeFileSync(real, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o700 });
  chmodSync(real, 0o700);
  try {
    return spawnSync(wrapper, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        MEEGLE_REQUEST_PROFILE: "lark-alice",
        MEEGLE_REAL_BIN: real,
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("wrapper rejects Agent attachment uploads", () => {
  const result = invoke(["attachment", "+upload", "/tmp/evidence.png"]);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /managed by the ticket bridge/);
});

test("wrapper rejects Agent multi-file field writes", () => {
  const result = invoke([
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

test("wrapper rejects Agent owner mutation but permits ordinary field updates", () => {
  const denied = invoke([
    "workflow",
    "update-node",
    "--params",
    JSON.stringify({ node_owners: ["alice"] }),
  ]);
  assert.equal(denied.status, 64);
  assert.match(denied.stderr, /owner writes/);

  const allowed = invoke([
    "workitem",
    "update",
    "--params",
    JSON.stringify({ fields: [{ field_key: "priority", field_value: "P1" }] }),
  ]);
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /--profile\nlark-alice\nworkitem\nupdate/);
});
