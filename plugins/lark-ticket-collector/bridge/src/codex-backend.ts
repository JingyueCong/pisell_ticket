import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeConfig } from "./config.js";
import { buildAgentPrompt } from "./prompt.js";
import type { AgentBackend, AgentRequest, AgentResult } from "./types.js";

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function buildCodexArgs(input: {
  config: BridgeConfig;
  request: AgentRequest;
  outputPath: string;
}): string[] {
  const args = [
    "exec",
    "--ephemeral",
    "--json",
    "--skip-git-repo-check",
    // --approve-for-me already selects the workspace-write sandbox. Passing
    // --sandbox as well is rejected by current Codex CLI releases.
    "--approve-for-me",
    "-C",
    input.config.codex.workspace,
    "--add-dir",
    input.request.resourceRoot,
    "-o",
    input.outputPath,
  ];
  if (input.config.codex.model) args.push("--model", input.config.codex.model);
  if (input.config.codex.profile) args.push("--profile", input.config.codex.profile);
  for (const resource of input.request.envelope.resources) {
    if (resource.type === "image" && resource.localPath) {
      args.push("--image", resource.localPath);
    }
  }
  args.push("-");
  return args;
}

function tail(value: string, max = 4_000): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function runProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
  stdin: string;
  timeoutMs: number;
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, input.timeoutMs);
    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) stdout = tail(stdout, 1_000_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 200_000) stderr = tail(stderr, 100_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });

    child.stdin.end(input.stdin);
  });
}

function extractFallbackText(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const candidates = [
        parsed.output_text,
        parsed.text,
        (parsed.message as Record<string, unknown> | undefined)?.text,
        (parsed.item as Record<string, unknown> | undefined)?.text,
      ];
      const match = candidates.find((value) => typeof value === "string" && value.trim());
      if (typeof match === "string") return match.trim();
    } catch {
      // JSONL may contain non-JSON diagnostics from wrappers. Ignore them.
    }
  }
  return undefined;
}

export class CodexCliBackend implements AgentBackend {
  constructor(private readonly config: BridgeConfig) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    const tempDirectory = await mkdtemp(join(tmpdir(), "ticket-collector-codex-"));
    const outputPath = join(tempDirectory, "last-message.md");
    const args = buildCodexArgs({ config: this.config, request, outputPath });

    try {
      const result = await runProcess({
        executable: this.config.codex.bin,
        args,
        cwd: this.config.codex.workspace,
        stdin: buildAgentPrompt(request),
        timeoutMs: this.config.codex.timeoutMs,
      });

      let text = "";
      try {
        text = (await readFile(outputPath, "utf8")).trim();
      } catch {
        text = extractFallbackText(result.stdout) ?? "";
      }

      if (result.timedOut) {
        throw new Error("工单处理超时；本次消息未确认完成，请作为一条新消息重新发送。");
      }
      if (result.exitCode !== 0) {
        const stderrSummary = tail(result.stderr).trim().split(/\r?\n/, 1)[0];
        throw new Error(
          `工单 Agent 执行失败（exit=${result.exitCode ?? "unknown"}）。${
            stderrSummary ? ` CLI: ${stderrSummary}` : ""
          }`,
        );
      }
      if (!text) {
        throw new Error("工单 Agent 未返回可发送的结果。");
      }

      const diagnostics = result.stderr.trim() ? [tail(result.stderr)] : [];
      return { text, diagnostics };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}
