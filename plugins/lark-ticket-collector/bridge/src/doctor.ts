import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "./config.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function run(executable: string, args: string[], cwd: string): Promise<Check> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (output += chunk));
    child.stderr.on("data", (chunk: string) => (output += chunk));
    child.on("error", (error) =>
      resolve({ name: executable, ok: false, detail: error.message }),
    );
    child.on("close", (code) =>
      resolve({
        name: executable,
        ok: code === 0,
        detail: output.trim().split(/\r?\n/).slice(-2).join(" | ") || `exit=${code}`,
      }),
    );
  });
}

async function fileCheck(
  name: string,
  path: string,
  mode: number = constants.R_OK,
): Promise<Check> {
  try {
    await access(path, mode);
    return { name, ok: true, detail: path };
  } catch {
    return { name, ok: false, detail: `missing: ${path}` };
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const larkArgs = [
    ...(config.lark.cliProfile ? ["--profile", config.lark.cliProfile] : []),
    ...(config.meegleIdentity.enabled && config.meegleIdentity.profileOverrides.size
      ? [
          "contact",
          "+search-user",
          "--user-ids",
          config.meegleIdentity.profileOverrides.keys().next().value as string,
          "--as",
          "user",
          "--format",
          "json",
        ]
      : ["whoami"]),
  ];
  const checks = await Promise.all([
    run(config.codex.bin, ["--version"], config.codex.workspace),
    run(
      config.meegleIdentity.bin,
      config.meegleIdentity.enabled
        ? ["--version"]
        : ["auth", "status", "--format", "json"],
      config.codex.workspace,
    ),
    run(config.lark.cliBin, larkArgs, config.codex.workspace),
    fileCheck("workspace rules", join(config.codex.workspace, "AGENTS.md")),
    fileCheck(
      "ticket configuration",
      join(config.codex.workspace, ".ticket-collector", "configuration", "runtime.json"),
    ),
    ...(config.meegleIdentity.enabled
      ? [fileCheck("Meegle profile wrapper", join(process.cwd(), "bin", "meegle"), constants.X_OK)]
      : []),
  ]);

  for (const check of checks) {
    process.stdout.write(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}\n`);
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

void main();
