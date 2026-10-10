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
  LARK_CLI_BIN: z.string().default("lark-cli"),
  ALLOWED_CHAT_IDS: z.string().default(""),
  ALLOWED_SENDER_IDS: z.string().default(""),
  YOKO_HANDOFF_CHAT_ID: optionalString,
  OPS_ALERT_CHAT_ID: optionalString,
  OPS_ALERT_COOLDOWN_MS: positiveInt(300_000),
  CONTENT_PRODUCER_SOURCE_CHAT_ID: optionalString,
  VISIT_RECORD_CHAT_IDS: z.string().default(""),
  AUTO_VISIT_RECORD_GROUPS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  REQUIRE_MENTION: booleanValue,
  BRIDGE_WORKSPACE: z.string().min(1),
  CODEX_BIN: z.string().default("codex"),
  CODEX_MODEL: optionalString,
  CODEX_PROFILE: optionalString,
  CODEX_TIMEOUT_MS: positiveInt(600_000),
  CODEX_PROBE_TIMEOUT_MS: positiveInt(30_000),
  CODEX_PROBE_INTERVAL_MS: positiveInt(30 * 60_000),
  CODEX_PROBE_FAILURE_THRESHOLD: positiveInt(2),
  CODEX_MAX_CONCURRENT_RUNS: positiveInt(2),
  PER_USER_MEEGLE_AUTH: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  MEEGLE_BIN: z.string().default("meegle"),
  MEEGLE_HOST: z.string().default("project.feishu.cn"),
  MEEGLE_PROJECT_KEY: z.string().default("v2qint"),
  MEEGLE_PROFILE_OVERRIDES: z.string().default(""),
  BRIDGE_DATA_DIR: z.string().default("./var"),
  BRIDGE_DB_PATH: z.string().default("./var/bridge.sqlite"),
  BRIDGE_RESOURCE_DIR: z.string().default("./var/resources"),
  HEALTH_HOST: z.string().default("127.0.0.1"),
  HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(8787),
  INTERNAL_API_TOKEN: optionalString,
  INTERNAL_TICKET_SENDER_ID: optionalString,
  INTERNAL_TICKET_SENDER_NAME: optionalString,
  INTERNAL_ATTACHMENT_ROOTS: z.string().default(""),
  MAX_REPLY_CHARS: positiveInt(12_000),
  MAX_HISTORY_MESSAGES: positiveInt(12),
  MAX_HISTORY_AGE_DAYS: positiveInt(30),
  DRAFT_TTL_HOURS: positiveInt(7 * 24),
  MAX_RESOURCE_BYTES: positiveInt(25 * 1024 * 1024),
  RESOURCE_RETENTION_DAYS: positiveInt(30),
  AUDIT_RETENTION_DAYS: positiveInt(180),
  MAINTENANCE_INTERVAL_MS: positiveInt(60 * 60_000),
});

const runtimeSchema = z
  .object({
    content_maintenance: z
      .object({
        producer_role_source: z.object({
          source_chat_id_env: z.literal("CONTENT_PRODUCER_SOURCE_CHAT_ID"),
          extract_pattern: z.string().min(1),
          name_split_pattern: z.string().min(1),
          confirmer_extract_pattern: z
            .string()
            .min(1)
            .default("确认\\s*[:：]\\s*(.+?)$"),
          confirmer_name_split_pattern: z
            .string()
            .min(1)
            .default("[/／、,，&＆]+"),
          target_confirmer_role_name: z.string().min(1).default("确认人"),
        }),
      })
      .optional(),
  })
  .passthrough();

export interface ContentMaintenanceProducerSourceConfig {
  chatId: string;
  extractPattern: string;
  nameSplitPattern: string;
  confirmerExtractPattern: string;
  confirmerNameSplitPattern: string;
  confirmerRoleName: string;
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
    new RegExp(source.confirmer_extract_pattern);
    new RegExp(source.confirmer_name_split_pattern);
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
    confirmerExtractPattern: source.confirmer_extract_pattern,
    confirmerNameSplitPattern: source.confirmer_name_split_pattern,
    confirmerRoleName: source.target_confirmer_role_name,
  };
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function mapping(value: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of list(value)) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(`Invalid sender/profile mapping: ${entry}`);
    }
    result.set(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim());
  }
  return result;
}

export interface BridgeConfig {
  lark: {
    appId: string;
    appSecret: string;
    cliProfile?: string;
    cliBin: string;
    allowedChatIds: string[];
    allowedSenderIds: string[];
    requireMention: boolean;
    contentMaintenanceProducerSource?: ContentMaintenanceProducerSourceConfig;
    handoffChatId?: string;
    opsAlertChatId?: string;
    opsAlertCooldownMs: number;
    visitRecordChatIds: string[];
    visitRecordAllGroups: boolean;
  };
  meegleIdentity: {
    enabled: boolean;
    bin: string;
    host: string;
    projectKey: string;
    profileOverrides: Map<string, string>;
  };
  codex: {
    bin: string;
    workspace: string;
    model?: string;
    profile?: string;
    timeoutMs: number;
    probeTimeoutMs: number;
    probeIntervalMs: number;
    probeFailureThreshold: number;
    maxConcurrentRuns: number;
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
  internalApi: {
    enabled: boolean;
    token?: string;
    submitterSenderId?: string;
    submitterName?: string;
    attachmentRoots?: string[];
  };
  maintenance: {
    resourceRetentionMs: number;
    auditRetentionMs: number;
    intervalMs: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const parsed = schema.parse(env);
  const internalFields = [parsed.INTERNAL_API_TOKEN, parsed.INTERNAL_TICKET_SENDER_ID];
  if (internalFields.some(Boolean) && !internalFields.every(Boolean)) {
    throw new Error(
      "INTERNAL_API_TOKEN and INTERNAL_TICKET_SENDER_ID must be configured together",
    );
  }
  if (parsed.INTERNAL_API_TOKEN && parsed.INTERNAL_API_TOKEN.length < 24) {
    throw new Error("INTERNAL_API_TOKEN must contain at least 24 characters");
  }
  if (
    parsed.INTERNAL_API_TOKEN &&
    !["127.0.0.1", "::1", "localhost"].includes(parsed.HEALTH_HOST)
  ) {
    throw new Error("the internal ticket API may only listen on a loopback host");
  }
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
      cliBin: parsed.LARK_CLI_BIN,
      allowedChatIds: list(parsed.ALLOWED_CHAT_IDS),
      allowedSenderIds: list(parsed.ALLOWED_SENDER_IDS),
      requireMention: parsed.REQUIRE_MENTION,
      ...(parsed.YOKO_HANDOFF_CHAT_ID
        ? { handoffChatId: parsed.YOKO_HANDOFF_CHAT_ID }
        : {}),
      ...(parsed.OPS_ALERT_CHAT_ID
        ? { opsAlertChatId: parsed.OPS_ALERT_CHAT_ID }
        : {}),
      opsAlertCooldownMs: parsed.OPS_ALERT_COOLDOWN_MS,
      ...(contentMaintenanceProducerSource
        ? { contentMaintenanceProducerSource }
        : {}),
      visitRecordChatIds: list(parsed.VISIT_RECORD_CHAT_IDS),
      visitRecordAllGroups: parsed.AUTO_VISIT_RECORD_GROUPS,
    },
    meegleIdentity: {
      enabled: parsed.PER_USER_MEEGLE_AUTH,
      bin: parsed.MEEGLE_BIN,
      host: parsed.MEEGLE_HOST,
      projectKey: parsed.MEEGLE_PROJECT_KEY,
      profileOverrides: mapping(parsed.MEEGLE_PROFILE_OVERRIDES),
    },
    codex: {
      bin: parsed.CODEX_BIN,
      workspace,
      ...(parsed.CODEX_MODEL ? { model: parsed.CODEX_MODEL } : {}),
      ...(parsed.CODEX_PROFILE ? { profile: parsed.CODEX_PROFILE } : {}),
      timeoutMs: parsed.CODEX_TIMEOUT_MS,
      probeTimeoutMs: parsed.CODEX_PROBE_TIMEOUT_MS,
      probeIntervalMs: parsed.CODEX_PROBE_INTERVAL_MS,
      probeFailureThreshold: parsed.CODEX_PROBE_FAILURE_THRESHOLD,
      maxConcurrentRuns: parsed.CODEX_MAX_CONCURRENT_RUNS,
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
    internalApi: {
      enabled: Boolean(parsed.INTERNAL_API_TOKEN && parsed.INTERNAL_TICKET_SENDER_ID),
      attachmentRoots: list(parsed.INTERNAL_ATTACHMENT_ROOTS).map((path) =>
        resolve(cwd, path),
      ),
      ...(parsed.INTERNAL_API_TOKEN ? { token: parsed.INTERNAL_API_TOKEN } : {}),
      ...(parsed.INTERNAL_TICKET_SENDER_ID
        ? { submitterSenderId: parsed.INTERNAL_TICKET_SENDER_ID }
        : {}),
      ...(parsed.INTERNAL_TICKET_SENDER_NAME
        ? { submitterName: parsed.INTERNAL_TICKET_SENDER_NAME }
        : {}),
    },
    maintenance: {
      resourceRetentionMs: parsed.RESOURCE_RETENTION_DAYS * 24 * 60 * 60_000,
      auditRetentionMs: parsed.AUDIT_RETENTION_DAYS * 24 * 60 * 60_000,
      intervalMs: parsed.MAINTENANCE_INTERVAL_MS,
    },
  };
}
