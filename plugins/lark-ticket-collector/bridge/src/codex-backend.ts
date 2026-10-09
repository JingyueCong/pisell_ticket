import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import { z } from "zod";

import { AgentBackendError } from "./agent-failure.js";
import type { BridgeConfig } from "./config.js";
import { buildAgentPrompt } from "./prompt.js";
import type { AgentBackend, AgentRequest, AgentResult } from "./types.js";

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CodexRuntimeProbeResult {
  durationMs: number;
}

export class CodexRuntimeCompatibilityError extends AgentBackendError {
  constructor(message: string) {
    super(message, "codex_runtime_incompatible", "none");
    this.name = "CodexRuntimeCompatibilityError";
  }
}

export const CODEX_RUNTIME_PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["READY"] },
  },
} as const;

const runtimeProbeOutput = z.object({ status: z.literal("READY") });

export function parseCodexRuntimeProbeOutput(rawOutput: string): { status: "READY" } {
  return runtimeProbeOutput.parse(JSON.parse(rawOutput));
}

export function isCodexRuntimeCompatibilityFailure(stderr: string): boolean {
  return [
    /supports_parallel_tool_calls/i,
    /unknown field\s+[`'"]/i,
    /field\s+[`'"][^`'"]+[`'"]\s+at line\s+\d+\s+column\s+\d+/i,
    /failed to (?:load|parse).*(?:config|configuration)/i,
    /error loading configuration/i,
  ].some((pattern) => pattern.test(stderr));
}

export const AGENT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "draft", "attachment_archive"],
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
    attachment_archive: {
      type: "object",
      additionalProperties: false,
      required: [
        "status",
        "expected_bindings",
        "verified_bindings",
        "targets",
        "note",
      ],
      properties: {
        status: {
          type: "string",
          enum: ["not_applicable", "pending", "verified", "failed"],
        },
        expected_bindings: { type: "integer", minimum: 0 },
        verified_bindings: { type: "integer", minimum: 0 },
        targets: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "work_item_id",
              "field_key",
              "expected_files",
              "verified_files",
            ],
            properties: {
              work_item_id: { type: "string", minLength: 1 },
              field_key: { type: "string", minLength: 1 },
              expected_files: { type: "integer", minimum: 0 },
              verified_files: { type: "integer", minimum: 0 },
            },
          },
        },
        note: { type: ["string", "null"] },
      },
    },
  },
} as const;

export function resolveExecutablePath(
  executable: string,
  pathValue = process.env.PATH ?? "",
  canExecute: (candidate: string) => boolean = (candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
): string {
  if (isAbsolute(executable)) return executable;
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, executable);
    if (canExecute(candidate)) return candidate;
  }
  throw new Error(`Unable to resolve executable to an absolute path: ${executable}`);
}

const agentOutput = z.object({
  reply: z.string().min(1),
  draft: z.object({
    action: z.enum(["none", "open", "update", "close"]),
    ticket_type: z.string().nullable(),
    summary: z.string().nullable(),
    missing_fields: z.array(z.string()).max(50),
    work_item_ids: z.array(z.string()).max(50),
  }),
  attachment_archive: z.object({
    status: z.enum(["not_applicable", "pending", "verified", "failed"]),
    expected_bindings: z.number().int().nonnegative(),
    verified_bindings: z.number().int().nonnegative(),
    targets: z
      .array(
        z.object({
          work_item_id: z.string().min(1),
          field_key: z.string().min(1),
          expected_files: z.number().int().nonnegative(),
          verified_files: z.number().int().nonnegative(),
        }),
      )
      .max(50),
    note: z.string().nullable(),
  }),
});

export function parseAgentOutput(
  rawOutput: string,
): Pick<AgentResult, "text" | "draft" | "attachmentArchive"> {
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
    attachmentArchive: {
      status: parsed.attachment_archive.status,
      expectedBindings: parsed.attachment_archive.expected_bindings,
      verifiedBindings: parsed.attachment_archive.verified_bindings,
      targets: parsed.attachment_archive.targets.map((target) => ({
        workItemId: target.work_item_id,
        fieldKey: target.field_key,
        expectedFiles: target.expected_files,
        verifiedFiles: target.verified_files,
      })),
      ...(parsed.attachment_archive.note?.trim()
        ? { note: parsed.attachment_archive.note.trim() }
        : {}),
    },
  };
}

export function buildCodexArgs(input: {
  config: BridgeConfig;
  request: AgentRequest;
  outputPath: string;
  schemaPath: string;
  meegleWrapperDirectory?: string;
  meegleRealBin?: string;
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
  const identity = input.request.envelope.meegleIdentity;
  if (identity) {
    const wrapperDirectory = input.meegleWrapperDirectory ?? join(process.cwd(), "bin");
    const meegleRealBin = input.meegleRealBin ?? resolveExecutablePath(input.config.meegleIdentity.bin);
    const commandPath = `${wrapperDirectory}:${process.env.PATH ?? ""}`;
    const tomlString = (value: string) => JSON.stringify(value);
    // The bridge process environment alone is insufficient: Codex may reuse a
    // shell snapshot or start a login shell whose startup files reorder PATH.
    args.push(
      "-c",
      "features.shell_snapshot=false",
      "-c",
      `shell_environment_policy.set.PATH=${tomlString(commandPath)}`,
      "-c",
      `shell_environment_policy.set.MEEGLE_REQUEST_PROFILE=${tomlString(identity.profile)}`,
      "-c",
      `shell_environment_policy.set.MEEGLE_REAL_BIN=${tomlString(meegleRealBin)}`,
    );
  }
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

export function buildCodexRuntimeProbeArgs(input: {
  config: BridgeConfig;
  outputPath: string;
  schemaPath: string;
}): string[] {
  const args = [
    "exec",
    "--ephemeral",
    "--json",
    "--skip-git-repo-check",
    "--approve-for-me",
    "-C",
    input.config.codex.workspace,
    "-o",
    input.outputPath,
    "--output-schema",
    input.schemaPath,
  ];
  if (input.config.codex.model) args.push("--model", input.config.codex.model);
  if (input.config.codex.profile) args.push("--profile", input.config.codex.profile);
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
  env?: NodeJS.ProcessEnv;
}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env ?? process.env,
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

  async probe(): Promise<CodexRuntimeProbeResult> {
    const tempDirectory = await mkdtemp(join(tmpdir(), "ticket-collector-codex-probe-"));
    const outputPath = join(tempDirectory, "probe-result.json");
    const schemaPath = join(tempDirectory, "probe.schema.json");
    await writeFile(schemaPath, JSON.stringify(CODEX_RUNTIME_PROBE_SCHEMA), {
      encoding: "utf8",
    });
    const startedAt = Date.now();

    try {
      let result: ProcessResult;
      try {
        result = await runProcess({
          executable: this.config.codex.bin,
          args: buildCodexRuntimeProbeArgs({
            config: this.config,
            outputPath,
            schemaPath,
          }),
          cwd: this.config.codex.workspace,
          stdin: [
            "You are a startup compatibility probe.",
            "Do not call tools, inspect files, or modify anything.",
            "Return only the requested JSON object with status READY.",
          ].join(" "),
          timeoutMs: this.config.codex.probeTimeoutMs,
        });
      } catch (error) {
        throw new CodexRuntimeCompatibilityError(
          `Codex CLI 无法启动：${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (result.timedOut) {
        throw new CodexRuntimeCompatibilityError(
          `Codex 启动探针在 ${this.config.codex.probeTimeoutMs}ms 内未完成。`,
        );
      }
      if (result.exitCode !== 0) {
        const stderrSummary = tail(result.stderr).trim().split(/\r?\n/, 1)[0];
        throw new CodexRuntimeCompatibilityError(
          `Codex 启动探针失败（exit=${result.exitCode ?? "unknown"}）。${
            stderrSummary ? ` CLI: ${stderrSummary}` : ""
          }`,
        );
      }

      let rawOutput = "";
      try {
        rawOutput = (await readFile(outputPath, "utf8")).trim();
      } catch {
        rawOutput = extractFallbackText(result.stdout) ?? "";
      }
      try {
        parseCodexRuntimeProbeOutput(rawOutput);
      } catch (error) {
        throw new CodexRuntimeCompatibilityError(
          `Codex 启动探针返回无效结果：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return { durationMs: Date.now() - startedAt };
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const tempDirectory = await mkdtemp(join(tmpdir(), "ticket-collector-codex-"));
    const outputPath = join(tempDirectory, "last-message.md");
    const schemaPath = join(tempDirectory, "agent-output.schema.json");
    await writeFile(schemaPath, JSON.stringify(AGENT_OUTPUT_SCHEMA), { encoding: "utf8" });
    const meegleWrapperDirectory = join(process.cwd(), "bin");
    const meegleWrapperPath = join(meegleWrapperDirectory, "meegle");
    const meegleRealBin = request.envelope.meegleIdentity
      ? resolveExecutablePath(this.config.meegleIdentity.bin)
      : this.config.meegleIdentity.bin;
    const args = buildCodexArgs({
      config: this.config,
      request,
      outputPath,
      schemaPath,
      meegleWrapperDirectory,
      meegleRealBin,
    });

    try {
      let result: ProcessResult;
      try {
        result = await runProcess({
          executable: this.config.codex.bin,
          args,
          cwd: this.config.codex.workspace,
          stdin: buildAgentPrompt(request, { meegleCommand: meegleWrapperPath }),
          timeoutMs: this.config.codex.timeoutMs,
          env: request.envelope.meegleIdentity
            ? {
                ...process.env,
                MEEGLE_REQUEST_PROFILE: request.envelope.meegleIdentity.profile,
                MEEGLE_REAL_BIN: meegleRealBin,
                PATH: `${join(process.cwd(), "bin")}:${process.env.PATH ?? ""}`,
              }
            : process.env,
        });
      } catch (error) {
        throw new CodexRuntimeCompatibilityError(
          `Codex CLI 无法启动：${error instanceof Error ? error.message : String(error)}`,
        );
      }

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
        if (isCodexRuntimeCompatibilityFailure(result.stderr)) {
          throw new CodexRuntimeCompatibilityError(
            `Codex 运行时不兼容（exit=${result.exitCode ?? "unknown"}）。${
              stderrSummary ? ` CLI: ${stderrSummary}` : ""
            }`,
          );
        }
        throw new Error(
          `工单 Agent 执行失败（exit=${result.exitCode ?? "unknown"}）。${
            stderrSummary ? ` CLI: ${stderrSummary}` : ""
          }`,
        );
      }
      if (!rawOutput) {
        throw new Error("工单 Agent 未返回可发送的结果。");
      }

      let parsed: Pick<AgentResult, "text" | "draft" | "attachmentArchive">;
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
