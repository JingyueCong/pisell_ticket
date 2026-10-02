import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

const booleanValue = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const positiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const optionalString = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

const schema = z.object({
  LARK_APP_ID: z.string().min(1),
  LARK_APP_SECRET: z.string().min(1),
  LARK_CLI_PROFILE: optionalString,
  ALLOWED_CHAT_IDS: z.string().default(""),
  ALLOWED_SENDER_IDS: z.string().default(""),
  YOKO_HANDOFF_CHAT_ID: optionalString,
  CONTENT_PRODUCER_SOURCE_CHAT_ID: optionalString,
  REQUIRE_MENTION: booleanValue,
  BRIDGE_WORKSPACE: z.string().min(1),
  CODEX_BIN: z.string().default("codex"),
  CODEX_MODEL: optionalString,
  CODEX_PROFILE: optionalString,
  CODEX_TIMEOUT_MS: positiveInt(600_000),
  BRIDGE_DATA_DIR: z.string().default("./var"),
  BRIDGE_DB_PATH: z.string().default("./var/bridge.sqlite"),
  BRIDGE_RESOURCE_DIR: z.string().default("./var/resources"),
  HEALTH_HOST: z.string().default("127.0.0.1"),
  HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  MAX_REPLY_CHARS: positiveInt(12_000),
  MAX_HISTORY_MESSAGES: positiveInt(12),
  MAX_HISTORY_AGE_DAYS: positiveInt(30),
  DRAFT_TTL_HOURS: positiveInt(7 * 24),
  MAX_RESOURCE_BYTES: positiveInt(25 * 1024 * 1024),
});

const runtimeSchema = z
  .object({
    content_maintenance: z
      .object({
        producer_role_source: z.object({
          source_chat_id_env: z.literal("CONTENT_PRODUCER_SOURCE_CHAT_ID"),
          extract_pattern: z.string().min(1),
          name_split_pattern: z.string().min(1),
        }),
      })
      .optional(),
  })
  .passthrough();

export interface ContentMaintenanceProducerSourceConfig {
  chatId: string;
  extractPattern: string;
  nameSplitPattern: string;
}

function loadContentMaintenanceProducerSource(
  workspace: string,
  chatId: string | undefined,
): ContentMaintenanceProducerSourceConfig | undefined {
  const path = join(workspace, ".ticket-collector", "configuration", "runtime.json");
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Unable to load Ticket Collector runtime configuration: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const source = runtimeSchema.parse(payload).content_maintenance?.producer_role_source;
  if (!source || !chatId) return undefined;
  try {
    new RegExp(source.extract_pattern);
    new RegExp(source.name_split_pattern);
  } catch (error) {
    throw new Error(
      `Invalid content-maintenance producer pattern: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    chatId,
    extractPattern: source.extract_pattern,
    nameSplitPattern: source.name_split_pattern,
  };
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export interface BridgeConfig {
  lark: {
    appId: string;
    appSecret: string;
    cliProfile?: string;
    allowedChatIds: string[];
    allowedSenderIds: string[];
    requireMention: boolean;
    contentMaintenanceProducerSource?: ContentMaintenanceProducerSourceConfig;
    handoffChatId?: string;
  };
  codex: {
    bin: string;
    workspace: string;
    model?: string;
    profile?: string;
    timeoutMs: number;
  };
  storage: {
    dataDir: string;
    dbPath: string;
    resourceDir: string;
  };
  limits: {
    maxReplyChars: number;
    maxHistoryMessages: number;
    maxHistoryAgeMs: number;
    draftTtlMs: number;
    maxResourceBytes: number;
  };
  health: {
    host: string;
    port: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const parsed = schema.parse(env);
  const cwd = process.cwd();
  const workspace = resolve(cwd, parsed.BRIDGE_WORKSPACE);
  const contentMaintenanceProducerSource =
    loadContentMaintenanceProducerSource(
      workspace,
      parsed.CONTENT_PRODUCER_SOURCE_CHAT_ID,
    );

  return {
    lark: {
      appId: parsed.LARK_APP_ID,
      appSecret: parsed.LARK_APP_SECRET,
      ...(parsed.LARK_CLI_PROFILE ? { cliProfile: parsed.LARK_CLI_PROFILE } : {}),
      allowedChatIds: list(parsed.ALLOWED_CHAT_IDS),
      allowedSenderIds: list(parsed.ALLOWED_SENDER_IDS),
      requireMention: parsed.REQUIRE_MENTION,
      ...(parsed.YOKO_HANDOFF_CHAT_ID
        ? { handoffChatId: parsed.YOKO_HANDOFF_CHAT_ID }
        : {}),
      ...(contentMaintenanceProducerSource
        ? { contentMaintenanceProducerSource }
        : {}),
    },
    codex: {
      bin: parsed.CODEX_BIN,
      workspace,
      ...(parsed.CODEX_MODEL ? { model: parsed.CODEX_MODEL } : {}),
      ...(parsed.CODEX_PROFILE ? { profile: parsed.CODEX_PROFILE } : {}),
      timeoutMs: parsed.CODEX_TIMEOUT_MS,
    },
    storage: {
      dataDir: resolve(cwd, parsed.BRIDGE_DATA_DIR),
      dbPath: resolve(cwd, parsed.BRIDGE_DB_PATH),
      resourceDir: resolve(cwd, parsed.BRIDGE_RESOURCE_DIR),
    },
    limits: {
      maxReplyChars: parsed.MAX_REPLY_CHARS,
      maxHistoryMessages: parsed.MAX_HISTORY_MESSAGES,
      maxHistoryAgeMs: parsed.MAX_HISTORY_AGE_DAYS * 24 * 60 * 60_000,
      draftTtlMs: parsed.DRAFT_TTL_HOURS * 60 * 60_000,
      maxResourceBytes: parsed.MAX_RESOURCE_BYTES,
    },
    health: {
      host: parsed.HEALTH_HOST,
      port: parsed.HEALTH_PORT,
    },
  };
}
