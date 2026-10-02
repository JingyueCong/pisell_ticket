import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import type { BridgeConfig } from "./config.js";
import { buildAgentPrompt } from "./prompt.js";
import type { AgentBackend, AgentRequest, AgentResult } from "./types.js";

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export const AGENT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "draft"],
  properties: {
    reply: { type: "string", minLength: 1 },
    draft: {
      type: "object",
      additionalProperties: false,
      required: ["action", "ticket_type", "summary", "missing_fields", "work_item_ids"],
      properties: {
        action: { type: "string", enum: ["none", "open", "update", "close"] },
        ticket_type: { type: ["string", "null"] },
        summary: { type: ["string", "null"] },
        missing_fields: { type: "array", items: { type: "string" }, maxItems: 50 },
        work_item_ids: { type: "array", items: { type: "string" }, maxItems: 50 },
      },
    },
  },
} as const;

const agentOutput = z.object({
  reply: z.string().min(1),
  draft: z.object({
    action: z.enum(["none", "open", "update", "close"]),
    ticket_type: z.string().nullable(),
    summary: z.string().nullable(),
    missing_fields: z.array(z.string()).max(50),
    work_item_ids: z.array(z.string()).max(50),
  }),
});

export function parseAgentOutput(rawOutput: string): Pick<AgentResult, "text" | "draft"> {
  const parsed = agentOutput.parse(JSON.parse(rawOutput));
  return {
    text: parsed.reply.trim(),
    draft: {
      action: parsed.draft.action,
      ...(parsed.draft.ticket_type?.trim()
        ? { ticketType: parsed.draft.ticket_type.trim() }
        : {}),
      ...(parsed.draft.summary?.trim() ? { summary: parsed.draft.summary.trim() } : {}),
      missingFields: parsed.draft.missing_fields,
      workItemIds: parsed.draft.work_item_ids,
    },
  };
}

export function buildCodexArgs(input: {
  config: BridgeConfig;
  request: AgentRequest;
  outputPath: string;
  schemaPath: string;
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
    "--output-schema",
    input.schemaPath,
  ];
  if (input.config.codex.model) args.push("--model", input.config.codex.model);
  if (input.config.codex.profile) args.push("--profile", input.config.codex.profile);
  const imagePaths = new Set<string>();
  for (const resource of [
    ...input.request.envelope.resources,
    ...(input.request.activeDraft?.resources ?? []),
  ]) {
    if (resource.type === "image" && resource.localPath) {
      imagePaths.add(resource.localPath);
    }
  }
  for (const path of imagePaths) args.push("--image", path);
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
    const schemaPath = join(tempDirectory, "agent-output.schema.json");
    await writeFile(schemaPath, JSON.stringify(AGENT_OUTPUT_SCHEMA), { encoding: "utf8" });
    const args = buildCodexArgs({ config: this.config, request, outputPath, schemaPath });

    try {
      const result = await runProcess({
        executable: this.config.codex.bin,
        args,
        cwd: this.config.codex.workspace,
        stdin: buildAgentPrompt(request),
        timeoutMs: this.config.codex.timeoutMs,
      });

      let rawOutput = "";
      try {
        rawOutput = (await readFile(outputPath, "utf8")).trim();
      } catch {
        rawOutput = extractFallbackText(result.stdout) ?? "";
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
      if (!rawOutput) {
        throw new Error("工单 Agent 未返回可发送的结果。");
      }

      let parsed: Pick<AgentResult, "text" | "draft">;
      try {
        parsed = parseAgentOutput(rawOutput);
      } catch (error) {
        throw new Error(
          `工单 Agent 返回了无效的结构化结果：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const diagnostics = result.stderr.trim() ? [tail(result.stderr)] : [];
      return {
        ...parsed,
        diagnostics,
      };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }
}
