import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import type { BridgeConfig } from "./config.js";
import type {
  VisitRecordChapter,
  VisitRecordEvidence,
  VisitRecordTodo,
} from "./types.js";

export interface VisitRecordProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type VisitRecordProcessRunner = (input: {
  executable: string;
  args: string[];
  cwd: string;
}) => Promise<VisitRecordProcessResult>;

export interface MinuteLink {
  token: string;
  url: string;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = stringValue(item);
    return text ? [text] : [];
  });
}

function runProcess(input: {
  executable: string;
  args: string[];
  cwd: string;
}): Promise<VisitRecordProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolveResult({ exitCode, stdout, stderr }));
  });
}

export function extractMinuteLinks(content: string): MinuteLink[] {
  const result = new Map<string, MinuteLink>();
  const pattern =
    /https?:\/\/[a-z0-9.-]+\/minutes\/([a-z0-9]+)(?:[/?#][^\s<>"'，。；、]*)?/giu;
  for (const match of content.matchAll(pattern)) {
    const token = match[1]?.toLowerCase();
    if (!token || result.has(token)) continue;
    const url = match[0].replace(/[)\]}>，。；、]+$/u, "");
    result.set(token, { token, url });
  }
  return [...result.values()];
}

export function isAutomaticVisitRecordMessage(input: {
  chatId: string;
  chatType: "p2p" | "group";
  content: string;
  visitRecordChatIds: string[];
}): boolean {
  return (
    input.chatType === "group" &&
    input.visitRecordChatIds.includes(input.chatId) &&
    extractMinuteLinks(input.content).length > 0
  );
}

export class VisitRecordError extends Error {}

export class VisitRecordLoader {
  constructor(
    private readonly config: BridgeConfig,
    private readonly runner: VisitRecordProcessRunner = runProcess,
  ) {}

  async load(input: {
    messageId: string;
    sourceChatId: string;
    sourceChatName: string;
    link: MinuteLink;
  }): Promise<VisitRecordEvidence> {
    const profile = this.config.lark.cliProfile;
    if (!profile) {
      throw new VisitRecordError("LARK_CLI_PROFILE 未配置，无法读取飞书妙记");
    }

    const directory = resolve(
      this.config.storage.resourceDir,
      input.messageId,
      `minute-${input.link.token}`,
    );
    await mkdir(directory, { recursive: true });
    const result = await this.runner({
      executable: this.config.lark.cliBin,
      cwd: directory,
      args: [
        "--profile",
        profile,
        "minutes",
        "+detail",
        "--as",
        "user",
        "--minute-tokens",
        input.link.token,
        "--summary",
        "--todo",
        "--chapter",
        "--keyword",
        "--transcript",
        "--overwrite",
        "--output-dir",
        ".",
        "--format",
        "json",
      ],
    });

    let payload: Record<string, unknown> | undefined;
    try {
      payload = objectValue(JSON.parse(result.stdout));
    } catch {
      payload = undefined;
    }
    if (result.exitCode !== 0 || payload?.ok === false) {
      const error = objectValue(payload?.error);
      const missing = stringArray(error?.missing_scopes);
      const detail =
        stringValue(error?.message) ??
        result.stderr.trim().split(/\r?\n/u).find(Boolean) ??
        "飞书妙记读取失败";
      throw new VisitRecordError(
        missing.length ? `${detail}（缺少权限：${missing.join(", ")}）` : detail,
      );
    }

    const envelope = objectValue(payload?.data) ?? payload;
    const minutes = Array.isArray(envelope?.minutes) ? envelope.minutes : [];
    const minute = minutes.map(objectValue).find(Boolean);
    if (!minute) {
      throw new VisitRecordError("飞书妙记接口未返回目标妙记");
    }
    const artifacts = objectValue(minute.artifacts) ?? {};
    const chapters: VisitRecordChapter[] = (Array.isArray(artifacts.chapters)
      ? artifacts.chapters
      : []
    ).flatMap((item) => {
      const chapter = objectValue(item);
      if (!chapter) return [];
      const title = stringValue(chapter.title);
      const startMs = stringValue(chapter.start_ms);
      const stopMs = stringValue(chapter.stop_ms);
      const chapterSummary = stringValue(
        chapter.summary_content ?? chapter.summary,
      );
      return [
        {
          ...(title ? { title } : {}),
          ...(startMs ? { startMs } : {}),
          ...(stopMs ? { stopMs } : {}),
          ...(chapterSummary ? { summary: chapterSummary } : {}),
        },
      ];
    });
    const todos: VisitRecordTodo[] = (Array.isArray(artifacts.todos)
      ? artifacts.todos
      : []
    ).flatMap((item) => {
      const todo = objectValue(item);
      if (!todo) return [];
      const content = stringValue(todo.content);
      const assignees = stringArray(todo.assignees);
      return [
        {
          ...(content ? { content } : {}),
          ...(assignees.length ? { assignees } : {}),
          ...(typeof todo.is_done === "boolean" ? { isDone: todo.is_done } : {}),
        },
      ];
    });

    const transcriptFile = stringValue(artifacts.transcript_file);
    let transcriptPath: string | undefined;
    if (transcriptFile) {
      const candidate = isAbsolute(transcriptFile)
        ? resolve(transcriptFile)
        : resolve(directory, transcriptFile);
      if (candidate === directory || candidate.startsWith(`${directory}${sep}`)) {
        transcriptPath = candidate;
      }
    }

    const summary = stringValue(artifacts.summary);
    if (!summary && !chapters.length && !todos.length && !transcriptPath) {
      throw new VisitRecordError("妙记尚未生成可读取的智能纪要或逐字稿");
    }

    const title = stringValue(minute.title);
    return {
      sourceChatId: input.sourceChatId,
      sourceChatName: input.sourceChatName,
      minuteToken: input.link.token,
      minuteUrl: input.link.url,
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      chapters,
      todos,
      keywords: stringArray(artifacts.keywords),
      ...(transcriptPath ? { transcriptPath } : {}),
      fetchedAt: Date.now(),
    };
  }
}
