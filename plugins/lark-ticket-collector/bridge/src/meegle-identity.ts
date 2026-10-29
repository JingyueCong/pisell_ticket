import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BridgeConfig } from "./config.js";
import { logger } from "./logger.js";
import type {
  ContentProducerAssignment,
  CustomerCrmCandidate,
  CustomerCrmResolution,
  MeegleRequestIdentity,
} from "./types.js";
import type { TicketTitleTargetType } from "./ticket-title-update.js";

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface PendingAuthorization {
  senderId: string;
  profile: string;
  client_id: string;
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expiresAt: number;
}

interface StoredBinding extends MeegleRequestIdentity {
  senderId: string;
  verifiedAt: number;
}

type AuthenticationStatus =
  | { kind: "authenticated" }
  | { kind: "unauthenticated"; reason?: string }
  | { kind: "unavailable"; reason?: string };

export type IdentityGateResult =
  | { kind: "authorized"; identity: MeegleRequestIdentity }
  | { kind: "blocked"; reply: string };

export interface CustomerNodeOwnerCorrection {
  nodeId: string;
  ownerUserKey: string;
}

export interface WorkItemTitleSummary {
  workItemId: string;
  name: string;
  typeDescriptors: string[];
}

export interface WorkItemTitleUpdateResult extends WorkItemTitleSummary {
  previousName: string;
  changed: boolean;
}

const CUSTOMER_CRM_WORK_ITEM_TYPE = "67df84a32e42950cb0195cba";
const CUSTOMER_SERVICE_WORK_ITEM_TYPE = "6886d47112cff2ae4ae279e3";
const CONTENT_MAINTENANCE_WORK_ITEM_TYPE = "67df87a8baf45c9c247ba778";
const BLOCKING_ISSUE_WORK_ITEM_TYPE = "67df88cf656f61b9b41455d3";
const OWNER_READBACK_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000] as const;
const AUTH_STATUS_RETRY_DELAYS_MS = [0, 500, 1_500] as const;
const AUTH_STATUS_TIMEOUT_MS = 8_000;
const IDENTITY_DEPENDENCY_RETRY_DELAYS_MS = [0, 500] as const;

export function isMeegleAuthorizationConfirmation(messageText: string): boolean {
  return /(已授权|授权完成|完成授权)/u.test(messageText);
}

export function isTemporaryIdentityVerificationFailure(error: unknown): boolean {
  const reason = error instanceof Error ? error.message : String(error);
  return /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ECONNREFUSED|socket hang up|server unreachable|temporar|timeout|timed out|network|connection|\b5\d\d\b/iu.test(
    reason,
  );
}

export type ProcessRunner = (
  executable: string,
  args: string[],
  timeoutMs?: number,
) => Promise<ProcessResult>;

function runProcess(
  executable: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function parseJson(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CLI returned a non-object JSON response");
  }
  return parsed as Record<string, unknown>;
}

function tryParseJson(text: string): Record<string, unknown> {
  try {
    return parseJson(text);
  } catch {
    return {};
  }
}

function safeAuthReason(payload: Record<string, unknown>, result: ProcessResult): string | undefined {
  const payloadReason = stringValue(payload.reason);
  const error = payload.error;
  const errorMessage =
    error && typeof error === "object" && !Array.isArray(error)
      ? stringValue((error as Record<string, unknown>).message)
      : undefined;
  const raw = payloadReason ?? errorMessage ?? stringValue(result.stderr);
  if (!raw) return undefined;
  return raw
    .replace(/https?:\/\/\S+/giu, "[url]")
    .replace(/[A-Z0-9]{5}-[A-Z0-9]{5}/gu, "[code]")
    .slice(0, 240);
}

function isTemporaryAuthFailure(result: ProcessResult, reason?: string): boolean {
  if (result.exitCode === null || result.exitCode === 2) return true;
  return /server unreachable|temporar|timeout|timed out|network|connection|\b5\d\d\b/iu.test(
    reason ?? "",
  );
}

function isRejectedToken(reason?: string): boolean {
  return /token rejected|invalid token|expired token/iu.test(reason ?? "");
}

function responseError(result: ProcessResult): string | undefined {
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    return stderr ? `exit=${result.exitCode}: ${stderr}` : `exit=${result.exitCode}`;
  }
  try {
    const payload = parseJson(result.stdout);
    if (!payload.error || typeof payload.error !== "object" || Array.isArray(payload.error)) {
      return undefined;
    }
    const error = payload.error as Record<string, unknown>;
    const code = stringValue(error.code);
    const message = stringValue(error.message);
    if (!code && !message) return "unknown API error";
    return [code, message].filter(Boolean).join(": ");
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function collectObjects(value: unknown, target: Array<Record<string, unknown>>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, target);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  target.push(object);
  for (const child of Object.values(object)) collectObjects(child, target);
}

function mqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function mqlLike(value: string): string {
  return mqlString(value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_"));
}

function scalarValue(value: unknown): string | undefined {
  if ((typeof value === "string" || typeof value === "number") && String(value).trim()) {
    return String(value).trim();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  for (const key of ["value", "label", "name", "text", "id"]) {
    const candidate = scalarValue(object[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

function typedFieldValue(object: Record<string, unknown>): string | undefined {
  const valueKeys = [
    "field_value",
    "fieldValue",
    "value",
    "values",
    "string_value",
    "stringValue",
    "text_value",
    "textValue",
    "bigint_value",
    "bigintValue",
    "long_value",
    "longValue",
    "int64_value",
    "int64Value",
    "integer_value",
    "integerValue",
    "number_value",
    "numberValue",
    "display_value",
    "displayValue",
    "raw_value",
    "rawValue",
  ];
  for (const key of valueKeys) {
    if (!Object.hasOwn(object, key)) continue;
    const candidate = scalarValue(object[key]);
    if (candidate) return candidate;
    const nestedValue = object[key];
    if (nestedValue && typeof nestedValue === "object" && !Array.isArray(nestedValue)) {
      const nested = typedFieldValue(nestedValue as Record<string, unknown>);
      if (nested) return nested;
    }
  }

  const valueType = object.value_type ?? object.valueType;
  if (valueType && typeof valueType === "object") {
    if (Array.isArray(valueType)) {
      for (const item of valueType) {
        const candidate = scalarValue(item);
        if (candidate) return candidate;
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const nested = typedFieldValue(item as Record<string, unknown>);
          if (nested) return nested;
        }
      }
    } else {
      const nested = typedFieldValue(valueType as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return undefined;
}

function selectedFieldValue(
  row: Record<string, unknown>,
  expectedDescriptors: ReadonlySet<string>,
): string | undefined {
  for (const containerKey of ["fields", "work_item_fields", "workItemFields"]) {
    const container = row[containerKey];
    if (!container || typeof container !== "object" || Array.isArray(container)) continue;
    for (const [key, value] of Object.entries(container as Record<string, unknown>)) {
      if (!expectedDescriptors.has(normalized(key))) continue;
      const candidate = scalarValue(value);
      if (candidate) return candidate;
    }
  }

  const objects: Array<Record<string, unknown>> = [];
  collectObjects(row, objects);
  for (const object of objects) {
    const descriptors = [
      object.field_key,
      object.fieldKey,
      object.field_name,
      object.fieldName,
      object.key,
      object.label,
    ]
      .map(scalarValue)
      .filter((value): value is string => Boolean(value))
      .map(normalized);
    if (!descriptors.some((descriptor) => expectedDescriptors.has(descriptor))) continue;
    const candidate = typedFieldValue(object);
    if (candidate) return candidate;
  }
  return undefined;
}

function customerCrmCandidates(value: unknown, projectKey: string): CustomerCrmCandidate[] {
  const objects: Array<Record<string, unknown>> = [];
  collectObjects(value, objects);
  const found = new Map<string, CustomerCrmCandidate>();
  const workItemIdDescriptors = new Set(
    ["work_item_id", "workItemId", "工作项ID", "工作项id"].map(normalized),
  );
  const nameDescriptors = new Set(
    ["name", "title", "名称", "店铺id 客户名称"].map(normalized),
  );
  const statusDescriptors = new Set(
    ["work_item_status", "workItemStatus", "status", "状态"].map(normalized),
  );
  for (const object of objects) {
    const hasSelectedFields = [
      "fields",
      "work_item_fields",
      "workItemFields",
      "moql_field_list",
    ].some((key) => Object.hasOwn(object, key));
    const workItemId =
      ["work_item_id", "workItemId", "工作项ID", "工作项id", "id"]
        .map((key) => scalarValue(object[key]))
        .find(Boolean) ??
      (hasSelectedFields
        ? selectedFieldValue(object, workItemIdDescriptors)
        : undefined);
    if (!workItemId || found.has(workItemId)) continue;
    const name =
      ["name", "名称", "title"]
        .map((key) => scalarValue(object[key]))
        .find(Boolean) ?? selectedFieldValue(object, nameDescriptors);
    if (!name) continue;
    const status =
      ["work_item_status", "workItemStatus", "状态", "status"]
        .map((key) => scalarValue(object[key]))
        .find(Boolean) ?? selectedFieldValue(object, statusDescriptors);
    found.set(workItemId, {
      workItemId,
      name,
      ...(status ? { status } : {}),
      url: `https://project.feishu.cn/${projectKey}/crm/detail/${workItemId}`,
    });
  }
  return [...found.values()].slice(0, 10);
}

function workItemTitleSummary(
  value: unknown,
  expectedWorkItemId: string,
): WorkItemTitleSummary {
  const objects: Array<Record<string, unknown>> = [];
  collectObjects(value, objects);
  const row = objects.find((object) =>
    [object.work_item_id, object.workItemId, object.id]
      .map(scalarValue)
      .some((candidate) => candidate === expectedWorkItemId),
  );
  if (!row) {
    throw new Error(`Work item #${expectedWorkItemId} was not returned`);
  }
  const nameDescriptors = new Set(["name", "title", "名称", "标题"].map(normalized));
  const name =
    [row.name, row.title, row.名称, row.标题]
      .map(scalarValue)
      .find(Boolean) ?? selectedFieldValue(row, nameDescriptors);
  if (!name) throw new Error(`Work item #${expectedWorkItemId} title was not returned`);
  const typeDescriptors = [
    row.work_item_type_key,
    row.workItemTypeKey,
    row.work_item_type_id,
    row.workItemTypeId,
    row.work_item_type,
    row.workItemType,
    row.type_key,
    row.typeKey,
    row.type_name,
    row.typeName,
  ]
    .map(scalarValue)
    .filter((descriptor): descriptor is string => Boolean(descriptor));
  return { workItemId: expectedWorkItemId, name, typeDescriptors };
}

function titleTargetTypeMatches(
  summary: WorkItemTitleSummary,
  targetType: TicketTitleTargetType,
): boolean {
  const values = summary.typeDescriptors.map(normalized);
  if (targetType === "customer") {
    return values.some(
      (value) =>
        value === normalized(CUSTOMER_SERVICE_WORK_ITEM_TYPE) ||
        value.includes(normalized("客服工单")),
    );
  }
  if (targetType === "blocking_issue") {
    return values.some(
      (value) =>
        value === normalized(BLOCKING_ISSUE_WORK_ITEM_TYPE) ||
        value.includes(normalized("阻断性问题")),
    );
  }
  return values.some(
    (value) =>
      value === normalized(CONTENT_MAINTENANCE_WORK_ITEM_TYPE) ||
      value.includes(normalized("内容维护")),
  );
}

function findWorkflowNode(
  payload: unknown,
  expectedName: string,
): Record<string, unknown> | undefined {
  const objects: Array<Record<string, unknown>> = [];
  collectObjects(payload, objects);
  return objects.find((object) =>
    [object.name, object.node_name, object.state_name, object.title].some(
      (value) => value === expectedName,
    ),
  );
}

function workflowNodeId(node: Record<string, unknown>): string | undefined {
  return (
    stringValue(node.state_key) ??
    stringValue(node.node_id) ??
    stringValue(node.node_key) ??
    stringValue(node.id)
  );
}

function collectOwnerKeys(value: unknown, target: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectOwnerKeys(child, target);
    return;
  }
  if (typeof value === "string" && value.trim()) {
    const candidate = value.trim();
    const wrapped = /^<id:([^>]+)>$/u.exec(candidate);
    target.add(wrapped?.[1] ?? candidate);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  const userKey =
    stringValue(object.user_key) ??
    stringValue(object.userKey) ??
    stringValue(object.user_id) ??
    stringValue(object.userId) ??
    stringValue(object.id);
  if (userKey) target.add(userKey);
  for (const child of Object.values(object)) {
    if (child && typeof child === "object") collectOwnerKeys(child, target);
  }
}

function workflowNodeOwnerKeys(node: Record<string, unknown>): Set<string> {
  const result = new Set<string>();
  const objects: Array<Record<string, unknown>> = [];
  collectObjects(node, objects);
  for (const object of objects) {
    const descriptors = [
      object.field_key,
      object.fieldKey,
      object.field_name,
      object.fieldName,
      object.name,
      object.label,
    ]
      .map(scalarValue)
      .filter((value): value is string => Boolean(value))
      .map(normalized);
    if (
      descriptors.some((descriptor) =>
        [
          "owner",
          "owners",
          "nodeowner",
          "nodeowners",
          "负责人",
          "当前负责人",
          "创建工单负责人",
        ].includes(descriptor) || descriptor.endsWith("负责人"),
      )
    ) {
      collectOwnerKeys(
        object.field_value ??
          object.fieldValue ??
          object.value ??
          object.values ??
          object.owners ??
          object.node_owners,
        result,
      );
    }
  }
  if (result.size) return result;
  for (const key of [
    "owner",
    "owners",
    "node_owners",
    "nodeOwners",
    "owner_list",
    "ownerList",
    "user_key_list",
    "userKeyList",
  ]) {
    if (Object.hasOwn(node, key)) collectOwnerKeys(node[key], result);
  }
  return result;
}

function exactRoleKey(payload: unknown, roleName: string): string {
  const objects: Array<Record<string, unknown>> = [];
  collectObjects(payload, objects);
  const keys = new Set<string>();
  for (const object of objects) {
    const name =
      stringValue(object.role_name) ??
      stringValue(object.roleName) ??
      stringValue(object.name);
    if (name !== roleName) continue;
    const key =
      stringValue(object.role_key) ??
      stringValue(object.roleKey) ??
      stringValue(object.role_id) ??
      stringValue(object.roleId) ??
      stringValue(object.id);
    if (key) keys.add(key);
  }
  if (keys.size !== 1) {
    throw new Error(
      `Content producer role must resolve uniquely (role=${roleName}, matches=${keys.size})`,
    );
  }
  return [...keys][0]!;
}

function exactUserKey(payload: unknown, expectedName: string): string {
  const objects: Array<Record<string, unknown>> = [];
  collectObjects(payload, objects);
  const expected = normalized(expectedName);
  const exact = new Set<string>();
  const all = new Set<string>();
  for (const object of objects) {
    const userKey = stringValue(object.user_key) ?? stringValue(object.userKey);
    if (!userKey) continue;
    all.add(userKey);
    const names = [
      object.name,
      object.name_cn,
      object.name_en,
      object.display_name,
      object.email,
    ]
      .map(scalarValue)
      .filter((value): value is string => Boolean(value));
    if (names.some((name) => normalized(name) === expected)) exact.add(userKey);
  }
  const matches = exact.size ? exact : all;
  if (matches.size !== 1) {
    throw new Error(
      `Content producer must resolve to one active Meegle user ` +
        `(name=${expectedName}, matches=${matches.size})`,
    );
  }
  return [...matches][0]!;
}

function roleOwnerKeysFromQuery(
  payload: unknown,
  workItemId: string,
  roleKey: string,
  roleName: string,
): Set<string> {
  const objects: Array<Record<string, unknown>> = [];
  collectObjects(payload, objects);
  const matchingRows = objects.filter((object) =>
    [object.work_item_id, object.workItemId, object.id]
      .map(scalarValue)
      .some((value) => value === workItemId),
  );
  const rows: Array<Record<string, unknown>> = [];
  if (matchingRows.length) {
    for (const row of matchingRows) collectObjects(row, rows);
  } else {
    rows.push(...objects);
  }
  const result = new Set<string>();
  const normalizedRoleName = normalized(roleName);
  const normalizedRoleKey = normalized(roleKey);
  for (const object of rows) {
    for (const [key, value] of Object.entries(object)) {
      if (
        key === roleKey ||
        key === roleName ||
        key === `__${roleName}` ||
        key.includes(roleName) ||
        normalized(key).includes(normalizedRoleName)
      ) {
        collectOwnerKeys(value, result);
      }
    }
    const fieldDescriptors = [
      object.field_key,
      object.fieldKey,
      object.field_name,
      object.fieldName,
      object.key,
      object.name,
      object.label,
    ]
      .map(scalarValue)
      .filter((value): value is string => Boolean(value))
      .map(normalized);
    if (
      fieldDescriptors.some(
        (descriptor) =>
          descriptor === normalizedRoleKey ||
          descriptor === normalizedRoleName ||
          descriptor.endsWith(normalizedRoleName),
      )
    ) {
      for (const key of [
        "field_value",
        "fieldValue",
        "values",
        "value",
        "owners",
        "owner",
        "user_keys",
        "userKeys",
      ]) {
        if (Object.hasOwn(object, key)) collectOwnerKeys(object[key], result);
      }
    }
    const objectRoleKey =
      stringValue(object.role_key) ??
      stringValue(object.roleKey) ??
      stringValue(object.role_id) ??
      stringValue(object.roleId);
    const objectRoleName =
      stringValue(object.role_name) ??
      stringValue(object.roleName);
    if (objectRoleKey === roleKey || objectRoleName === roleName) {
      for (const key of ["owners", "owner", "user_keys", "userKeys", "value"]) {
        if (Object.hasOwn(object, key)) collectOwnerKeys(object[key], result);
      }
    }
  }
  return result;
}

function isExpectedSingleOwner(
  owners: Set<string>,
  expectedUserKey: string,
  expectedName: string,
): boolean {
  if (owners.size !== 1) return false;
  const actual = [...owners][0]!;
  return actual === expectedUserKey || normalized(actual) === normalized(expectedName);
}

function removableOwnerKeys(owners: Set<string>, expectedUserKey: string): string[] {
  return [...owners].filter(
    (owner) =>
      owner !== expectedUserKey &&
      (/^\d{10,}$/u.test(owner) || /^(?:ou_|user_|u_)/u.test(owner)),
  );
}

function mqlIdentifier(value: string): string {
  return value.replaceAll("`", "``");
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}@._+-]+/gu, "");
}

function nameTokens(values: string[]): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    const whole = normalized(value);
    if (whole.length >= 2) result.add(whole);
    for (const part of value.split(/[\s()（）/／,，、]+/u)) {
      const token = normalized(part);
      if (token.length >= 2) result.add(token);
    }
  }
  return result;
}

function identitiesMatch(input: {
  meegleEmail?: string;
  meegleNames: string[];
  larkEmails: string[];
  larkNames: string[];
}): boolean {
  if (input.meegleEmail) {
    const email = normalized(input.meegleEmail);
    if (input.larkEmails.some((candidate) => normalized(candidate) === email)) return true;
  }
  const left = nameTokens(input.meegleNames);
  const right = nameTokens(input.larkNames);
  return [...left].some((token) => right.has(token));
}

export class MeegleIdentityManager {
  private readonly directory: string;
  private readonly profileLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly config: BridgeConfig,
    private readonly runner: ProcessRunner = runProcess,
    private readonly pause: (durationMs: number) => Promise<void> = (durationMs) =>
      new Promise((resolve) => setTimeout(resolve, durationMs)),
  ) {
    this.directory = join(config.storage.dataDir, "meegle-identities");
  }

  async authorize(input: {
    senderId: string;
    senderName?: string;
    messageText: string;
  }): Promise<IdentityGateResult> {
    const profile = this.profileFor(input.senderId);
    return this.withProfileLock(profile, async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      return this.authorizeWithDependencyRetry(profile, input);
    });
  }

  private async authorizeWithDependencyRetry(
    profile: string,
    input: { senderId: string; senderName?: string; messageText: string },
  ): Promise<IdentityGateResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < IDENTITY_DEPENDENCY_RETRY_DELAYS_MS.length; attempt += 1) {
      const delayMs = IDENTITY_DEPENDENCY_RETRY_DELAYS_MS[attempt]!;
      if (delayMs > 0) await this.pause(delayMs);
      try {
        return await this.authorizeLocked(profile, input);
      } catch (error) {
        if (!isTemporaryIdentityVerificationFailure(error)) throw error;
        lastError = error;
        const finalAttempt = attempt === IDENTITY_DEPENDENCY_RETRY_DELAYS_MS.length - 1;
        logger.warn(finalAttempt ? "meegle.identity_dependency_unavailable" : "meegle.identity_dependency_retry", {
          profile,
          attempt: attempt + 1,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        });
      }
    }
    throw lastError;
  }

  private async authorizeLocked(
    profile: string,
    input: { senderId: string; senderName?: string; messageText: string },
  ): Promise<IdentityGateResult> {
    const status = await this.authenticationStatus(profile);
    if (status.kind === "authenticated") {
      await this.archivePending(profile);
      const binding = await this.readBinding(profile);
      if (binding?.senderId === input.senderId) {
        const current = await this.meegle(profile, ["user", "me", "--format", "json"], true);
        const currentUserKey = stringValue(parseJson(current.stdout).user_key);
        if (currentUserKey === binding.userKey) {
          return { kind: "authorized", identity: binding };
        }
        await Promise.all([
          rm(this.bindingPath(profile), { force: true }),
          this.meegle(profile, ["auth", "logout", "--format", "json"]),
        ]);
        return {
          kind: "blocked",
          reply: "当前飞书项目登录身份与已验证员工不一致，旧绑定已撤销。请重新发送工单，并使用你本人的账号完成授权。",
        };
      }
      return this.verifyAndBind(profile, input.senderId, input.senderName);
    }

    if (status.kind === "unavailable") {
      return {
        kind: "blocked",
        reply:
          "飞书项目认证服务暂时不可用，系统已保留当前内容并完成自动重试。无需重新授权，请稍后重新发送本条消息。",
      };
    }

    const pending = await this.readPending(profile);
    const isConfirmation = isMeegleAuthorizationConfirmation(input.messageText);
    if (pending && pending.expiresAt > Date.now() && isConfirmation) {
      const poll = await this.meegle(profile, [
        "auth",
        "login",
        "--device-code",
        "--phase",
        "poll",
        "--client-id",
        pending.client_id,
        "--device-code-value",
        pending.device_code,
        "--once",
        "--host",
        this.config.meegleIdentity.host,
        "--format",
        "json",
      ]);
      if (poll.exitCode !== 0) {
        return {
          kind: "blocked",
          reply: "尚未检测到飞书项目授权。请先打开之前的个人授权链接完成登录，然后再次回复“已授权”。",
        };
      }
      const refreshedStatus = await this.authenticationStatus(profile);
      if (refreshedStatus.kind === "unavailable") {
        return {
          kind: "blocked",
          reply:
            "飞书项目暂时无法确认授权状态，系统已保留当前内容并完成自动重试。无需重新授权，请稍后再次回复“已授权”。",
        };
      }
      if (refreshedStatus.kind !== "authenticated") {
        return {
          kind: "blocked",
          reply: "授权仍在等待完成。请完成个人授权后再次回复“已授权”。",
        };
      }
      return this.verifyAndBind(profile, input.senderId, input.senderName);
    }

    if (pending && pending.expiresAt > Date.now()) {
      return this.pendingAuthorizationReply(pending, true);
    }
    if (pending) await this.archivePending(profile);

    await this.meegle(profile, [
      "config",
      "set",
      "host",
      this.config.meegleIdentity.host,
    ], true);
    const initialized = await this.meegle(profile, [
      "auth",
      "login",
      "--device-code",
      "--phase",
      "init",
      "--host",
      this.config.meegleIdentity.host,
      "--format",
      "json",
    ], true);
    const payload = parseJson(initialized.stdout);
    const expiresIn = Number(payload.expires_in);
    const next: PendingAuthorization = {
      senderId: input.senderId,
      profile,
      client_id: stringValue(payload.client_id) ?? "",
      device_code: stringValue(payload.device_code) ?? "",
      user_code: stringValue(payload.user_code) ?? "",
      verification_uri_complete:
        stringValue(payload.verification_uri_complete) ??
        stringValue(payload.verification_uri) ??
        "",
      expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 1_800) * 1_000,
    };
    if (!next.client_id || !next.device_code || !next.verification_uri_complete) {
      throw new Error("Meegle device authorization response is incomplete");
    }
    await this.writePrivate(this.pendingPath(profile), next);
    return this.pendingAuthorizationReply(next, false);
  }

  async ensureCustomerIntakeNodeOwner(input: {
    identity: MeegleRequestIdentity;
    workItemId: string;
  }): Promise<CustomerNodeOwnerCorrection> {
    const nodeQuery = [
      "workflow",
      "get-node",
      "--project-key",
      this.config.meegleIdentity.projectKey,
      "--work-item-id",
      input.workItemId,
      "--node-id-list",
      "_all",
      "--field-key-list",
      "_all",
      "--format",
      "json",
    ];
    const readNode = async (): Promise<{
      node?: Record<string, unknown>;
      owners: Set<string>;
    }> => {
      const current = await this.meegle(input.identity.profile, nodeQuery, true);
      const node = findWorkflowNode(JSON.parse(current.stdout) as unknown, "创建工单");
      const owners = node ? workflowNodeOwnerKeys(node) : new Set<string>();
      if (owners.size) return { ...(node ? { node } : {}), owners };

      const mql =
        "SELECT `work_item_id`, get_node_attribute('创建工单','负责人') " +
        `FROM \`${mqlIdentifier(this.config.meegleIdentity.projectKey)}\`.` +
        `\`${CUSTOMER_SERVICE_WORK_ITEM_TYPE}\` ` +
        `WHERE \`work_item_id\` = ${input.workItemId} LIMIT 1`;
      const fallback = await this.meegle(
        input.identity.profile,
        [
          "workitem",
          "query",
          "--project-key",
          this.config.meegleIdentity.projectKey,
          "--mql",
          mql,
          "--format",
          "json",
        ],
        true,
      );
      return {
        ...(node ? { node } : {}),
        owners: roleOwnerKeysFromQuery(
          JSON.parse(fallback.stdout) as unknown,
          input.workItemId,
          "负责人",
          "负责人",
        ),
      };
    };

    const current = await readNode();
    const node = current.node;
    if (!node) throw new Error("Customer ticket intake node was not returned");
    const nodeId = workflowNodeId(node);
    if (!nodeId) throw new Error("Customer ticket intake node has no node id");
    if (
      isExpectedSingleOwner(
        current.owners,
        input.identity.userKey,
        input.identity.name,
      )
    ) {
      return { nodeId, ownerUserKey: input.identity.userKey };
    }

    await this.meegle(
      input.identity.profile,
      [
        "workflow",
        "update-node",
        "--params",
        JSON.stringify({
          project_key: this.config.meegleIdentity.projectKey,
          work_item_id: input.workItemId,
          node_id: nodeId,
          node_owners: [input.identity.userKey],
        }),
        "--format",
        "json",
      ],
      true,
    );

    let verifiedOwners = new Set<string>();
    for (const delayMs of OWNER_READBACK_DELAYS_MS) {
      if (delayMs > 0) await this.pause(delayMs);
      const verified = await readNode();
      verifiedOwners = verified.owners;
      if (isExpectedSingleOwner(
        verifiedOwners,
        input.identity.userKey,
        input.identity.name,
      )) {
        return { nodeId, ownerUserKey: input.identity.userKey };
      }
    }
    throw new Error(
      `Customer ticket intake node owner verification failed after ${OWNER_READBACK_DELAYS_MS.length} reads ` +
        `(expected=${input.identity.userKey}, actual=${[...verifiedOwners].join(",") || "none"})`,
    );
  }

  async ensureContentMaintenanceProducer(input: {
    identity: MeegleRequestIdentity;
    workItemId: string;
    producerName: string;
    roleName?: string;
  }): Promise<ContentProducerAssignment> {
    const roleName = input.roleName?.trim() || "制作人&交付人";
    const roleMetadata = await this.meegle(
      input.identity.profile,
      [
        "workitem",
        "meta-roles",
        "--project-key",
        this.config.meegleIdentity.projectKey,
        "--work-item-type",
        CONTENT_MAINTENANCE_WORK_ITEM_TYPE,
        "--page-num",
        "1",
        "--role-query",
        roleName,
        "--format",
        "json",
      ],
      true,
    );
    const roleKey = exactRoleKey(JSON.parse(roleMetadata.stdout) as unknown, roleName);

    const userSearch = await this.meegle(
      input.identity.profile,
      [
        "user",
        "search",
        "--project-key",
        this.config.meegleIdentity.projectKey,
        "--user-keys",
        JSON.stringify([input.producerName]),
        "--format",
        "json",
      ],
      true,
    );
    const producerUserKey = exactUserKey(
      JSON.parse(userSearch.stdout) as unknown,
      input.producerName,
    );
    const assignment: ContentProducerAssignment = {
      roleKey,
      roleName,
      producerName: input.producerName,
      producerUserKey,
    };
    const query = async (): Promise<Set<string>> => {
      const mql =
        `SELECT \`work_item_id\`, \`__${mqlIdentifier(roleName)}\` ` +
        `FROM \`${mqlIdentifier(this.config.meegleIdentity.projectKey)}\`.` +
        `\`${CONTENT_MAINTENANCE_WORK_ITEM_TYPE}\` ` +
        `WHERE \`work_item_id\` = ${input.workItemId} LIMIT 1`;
      const result = await this.meegle(
        input.identity.profile,
        [
          "workitem",
          "query",
          "--project-key",
          this.config.meegleIdentity.projectKey,
          "--mql",
          mql,
          "--format",
          "json",
        ],
        true,
      );
      return roleOwnerKeysFromQuery(
        JSON.parse(result.stdout) as unknown,
        input.workItemId,
        roleKey,
        roleName,
      );
    };

    const currentOwners = await query();
    if (!isExpectedSingleOwner(currentOwners, producerUserKey, input.producerName)) {
      const roleOperate = [
        ...removableOwnerKeys(currentOwners, producerUserKey)
          .map((userKey) => ({ op: "remove", role_key: roleKey, user_keys: [userKey] })),
        ...(!currentOwners.has(producerUserKey)
          ? [{ op: "add", role_key: roleKey, user_keys: [producerUserKey] }]
          : []),
      ];
      if (!roleOperate.length) {
        throw new Error("Content producer role readback did not expose correctable owners");
      }
      await this.meegle(
        input.identity.profile,
        [
          "workitem",
          "update",
          "--project-key",
          this.config.meegleIdentity.projectKey,
          "--work-item-id",
          input.workItemId,
          "--role-operate",
          JSON.stringify(roleOperate),
          "--format",
          "json",
        ],
        true,
      );
    }

    let verifiedOwners = currentOwners;
    for (const delayMs of OWNER_READBACK_DELAYS_MS) {
      if (delayMs > 0) await this.pause(delayMs);
      verifiedOwners = await query();
      if (isExpectedSingleOwner(
        verifiedOwners,
        producerUserKey,
        input.producerName,
      )) {
        return assignment;
      }
    }
    throw new Error(
      `Content producer verification failed after ${OWNER_READBACK_DELAYS_MS.length} reads ` +
        `(expected=${producerUserKey}, actual=${[...verifiedOwners].join(",") || "none"})`,
    );
  }

  async resolveContentMaintenanceProducer(input: {
    identity: MeegleRequestIdentity;
    producerName: string;
  }): Promise<Pick<ContentProducerAssignment, "producerName" | "producerUserKey">> {
    const producerName = input.producerName.trim();
    const userSearch = await this.meegle(
      input.identity.profile,
      [
        "user",
        "search",
        "--project-key",
        this.config.meegleIdentity.projectKey,
        "--user-keys",
        JSON.stringify([producerName]),
        "--format",
        "json",
      ],
      true,
    );
    return {
      producerName,
      producerUserKey: exactUserKey(JSON.parse(userSearch.stdout) as unknown, producerName),
    };
  }

  async resolveCustomerCrm(input: {
    identity: MeegleRequestIdentity;
    merchantName: string;
    lookupHint?: string;
  }): Promise<CustomerCrmResolution> {
    const merchantName = input.merchantName.trim();
    const lookupHint = input.lookupHint?.trim();
    if (!merchantName) throw new Error("merchant name is required for CRM lookup");
    const projectKey = this.config.meegleIdentity.projectKey;
    const query = async (where: string): Promise<CustomerCrmCandidate[]> => {
      const mql =
        "SELECT `work_item_id`, `name` " +
        `FROM \`${projectKey}\`.\`${CUSTOMER_CRM_WORK_ITEM_TYPE}\` ` +
        `WHERE ${where} LIMIT 10`;
      const result = await this.meegle(
        input.identity.profile,
        [
          "workitem",
          "query",
          "--project-key",
          projectKey,
          "--mql",
          mql,
          "--format",
          "json",
        ],
        true,
      );
      return customerCrmCandidates(JSON.parse(result.stdout) as unknown, projectKey);
    };

    let candidates: CustomerCrmCandidate[] = [];
    let matchMethod: CustomerCrmResolution["matchMethod"] = "exact_name";
    if (lookupHint && /^\d{6,30}$/u.test(lookupHint)) {
      const byId = await query(`\`work_item_id\` = ${lookupHint}`);
      if (byId.length === 1) {
        const left = merchantName.replaceAll(/\s+/gu, "").toLocaleLowerCase();
        const right = byId[0]!.name.replaceAll(/\s+/gu, "").toLocaleLowerCase();
        if (left.includes(right) || right.includes(left)) {
          candidates = byId;
          matchMethod = "work_item_id";
        }
      }
    }
    if (!candidates.length) {
      candidates = await query(`\`name\` = '${mqlString(merchantName)}'`);
      matchMethod = "exact_name";
    }
    if (lookupHint && lookupHint.toLocaleLowerCase() !== merchantName.toLocaleLowerCase() && candidates.length !== 1) {
      candidates = await query(
        `(\`name\` LIKE '%${mqlLike(merchantName)}%' AND \`name\` LIKE '%${mqlLike(lookupHint)}%')`,
      );
      matchMethod = "name_and_hint";
    }
    if (!candidates.length) {
      candidates = await query(`\`name\` LIKE '%${mqlLike(merchantName)}%'`);
      matchMethod = "fuzzy_name";
    }
    return {
      status: candidates.length === 1 ? "unique" : candidates.length ? "ambiguous" : "not_found",
      query: { merchantName, ...(lookupHint ? { lookupHint } : {}) },
      matchMethod,
      candidates,
      readOnly: true,
    };
  }

  async resolveCustomerCrmCandidatesByIds(input: {
    identity: MeegleRequestIdentity;
    workItemIds: string[];
  }): Promise<CustomerCrmCandidate[]> {
    const workItemIds = [
      ...new Set(input.workItemIds.map((value) => value.trim()).filter((value) => /^\d+$/u.test(value))),
    ].slice(0, 10);
    const candidates = new Map<string, CustomerCrmCandidate>();
    for (const workItemId of workItemIds) {
      const projectKey = this.config.meegleIdentity.projectKey;
      const mql =
        "SELECT `work_item_id`, `name` " +
        `FROM \`${projectKey}\`.\`${CUSTOMER_CRM_WORK_ITEM_TYPE}\` ` +
        `WHERE \`work_item_id\` = ${workItemId} LIMIT 1`;
      const result = await this.meegle(
        input.identity.profile,
        [
          "workitem",
          "query",
          "--project-key",
          projectKey,
          "--mql",
          mql,
          "--format",
          "json",
        ],
        true,
      );
      for (const candidate of customerCrmCandidates(
        JSON.parse(result.stdout) as unknown,
        projectKey,
      )) {
        if (candidate.workItemId === workItemId) candidates.set(workItemId, candidate);
      }
    }
    return workItemIds
      .map((workItemId) => candidates.get(workItemId))
      .filter((candidate): candidate is CustomerCrmCandidate => Boolean(candidate));
  }

  async resolveWorkItemTitleTarget(input: {
    identity: MeegleRequestIdentity;
    candidateWorkItemIds: string[];
    targetType: TicketTitleTargetType;
  }): Promise<WorkItemTitleSummary[]> {
    const ids = [
      ...new Set(
        input.candidateWorkItemIds
          .map((value) => value.trim())
          .filter((value) => /^\d+$/u.test(value)),
      ),
    ].slice(0, 10);
    const summaries: WorkItemTitleSummary[] = [];
    for (const workItemId of ids) {
      const summary = await this.readWorkItemTitleSummary(
        input.identity.profile,
        workItemId,
      );
      if (titleTargetTypeMatches(summary, input.targetType)) summaries.push(summary);
    }
    return summaries;
  }

  async renameWorkItemTitle(input: {
    identity: MeegleRequestIdentity;
    workItemId: string;
    newTitle: string;
  }): Promise<WorkItemTitleUpdateResult> {
    const workItemId = input.workItemId.trim();
    const newTitle = input.newTitle.trim();
    if (!/^\d+$/u.test(workItemId)) throw new Error("Work item ID must be numeric");
    if (!newTitle || newTitle.length > 200) {
      throw new Error("Work item title must contain 1 to 200 characters");
    }
    const current = await this.readWorkItemTitleSummary(
      input.identity.profile,
      workItemId,
    );
    if (current.name === newTitle) {
      return { ...current, previousName: current.name, changed: false };
    }
    await this.meegle(
      input.identity.profile,
      [
        "workitem",
        "update",
        "--project-key",
        this.config.meegleIdentity.projectKey,
        "--work-item-id",
        workItemId,
        "--fields",
        JSON.stringify([{ field_key: "name", field_value: newTitle }]),
        "--format",
        "json",
      ],
      true,
    );
    let verified = current;
    for (const delayMs of OWNER_READBACK_DELAYS_MS) {
      if (delayMs > 0) await this.pause(delayMs);
      verified = await this.readWorkItemTitleSummary(
        input.identity.profile,
        workItemId,
      );
      if (verified.name === newTitle) {
        return { ...verified, previousName: current.name, changed: true };
      }
    }
    throw new Error(
      `Work item #${workItemId} title readback did not match the requested value`,
    );
  }

  private async readWorkItemTitleSummary(
    profile: string,
    workItemId: string,
  ): Promise<WorkItemTitleSummary> {
    const result = await this.meegle(
      profile,
      [
        "workitem",
        "get",
        "--project-key",
        this.config.meegleIdentity.projectKey,
        "--work-item-id",
        workItemId,
        "--fields",
        JSON.stringify(["name"]),
        "--format",
        "json",
      ],
      true,
    );
    return workItemTitleSummary(JSON.parse(result.stdout) as unknown, workItemId);
  }

  private async authenticationStatus(profile: string): Promise<AuthenticationStatus> {
    let lastReason: string | undefined;
    for (let attempt = 0; attempt < AUTH_STATUS_RETRY_DELAYS_MS.length; attempt += 1) {
      const delayMs = AUTH_STATUS_RETRY_DELAYS_MS[attempt]!;
      if (delayMs > 0) await this.pause(delayMs);

      const result = await this.meegle(
        profile,
        ["auth", "status", "--format", "json"],
        false,
        AUTH_STATUS_TIMEOUT_MS,
      );
      const payload = tryParseJson(result.stdout);
      const reason = safeAuthReason(payload, result);
      lastReason = reason;
      if (payload.authenticated === true) {
        if (attempt > 0) {
          logger.info("meegle.auth_status_recovered", {
            profile,
            attempts: attempt + 1,
          });
        }
        return { kind: "authenticated" };
      }

      const temporary = isTemporaryAuthFailure(result, reason);
      const rejected = isRejectedToken(reason);
      const finalAttempt = attempt === AUTH_STATUS_RETRY_DELAYS_MS.length - 1;
      if (!temporary && !rejected) {
        return {
          kind: "unauthenticated",
          ...(reason ? { reason } : {}),
        };
      }
      if (finalAttempt) {
        if (rejected) {
          return {
            kind: "unauthenticated",
            ...(reason ? { reason } : {}),
          };
        }
        logger.warn("meegle.auth_status_unavailable", {
          profile,
          attempts: attempt + 1,
          exitCode: result.exitCode,
          ...(reason ? { reason } : {}),
        });
        return {
          kind: "unavailable",
          ...(reason ? { reason } : {}),
        };
      }
      logger.warn("meegle.auth_status_retry", {
        profile,
        attempt: attempt + 1,
        exitCode: result.exitCode,
        ...(reason ? { reason } : {}),
      });
    }
    return {
      kind: "unavailable",
      ...(lastReason ? { reason: lastReason } : {}),
    };
  }

  private pendingAuthorizationReply(
    pending: PendingAuthorization,
    existing: boolean,
  ): IdentityGateResult {
    return {
      kind: "blocked",
      reply: [
        existing
          ? "已有一项待完成的飞书项目个人授权，请继续使用同一个授权链接；系统不会重复生成授权请求。"
          : "首次使用需要绑定你本人的飞书项目身份，授权完成后系统“创建人”才会显示为你。",
        "",
        `[点击完成个人授权](${pending.verification_uri_complete})`,
        `用户代码：${pending.user_code}`,
        "",
        "完成后请在本消息下回复“已授权”，验证通过后再重新发送原始工单和附件。系统不会回退使用 Echo 身份。",
      ].join("\n"),
    };
  }

  private async withProfileLock<T>(profile: string, action: () => Promise<T>): Promise<T> {
    const previous = this.profileLocks.get(profile) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.profileLocks.set(profile, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.profileLocks.get(profile) === tail) this.profileLocks.delete(profile);
    }
  }

  private profileFor(senderId: string): string {
    const overridden = this.config.meegleIdentity.profileOverrides.get(senderId);
    if (overridden) return overridden;
    return `lark-${createHash("sha256").update(senderId).digest("hex").slice(0, 16)}`;
  }

  private async verifyAndBind(
    profile: string,
    senderId: string,
    senderName?: string,
  ): Promise<IdentityGateResult> {
    const meegleResult = await this.meegle(profile, ["user", "me", "--format", "json"], true);
    const meegleUser = parseJson(meegleResult.stdout);
    const userKey = stringValue(meegleUser.user_key);
    const email = stringValue(meegleUser.email);
    const meegleNames = [
      stringValue(meegleUser.name_cn),
      stringValue(meegleUser.name_en),
      stringValue(meegleUser.name),
    ].filter((value): value is string => Boolean(value));

    const larkUser = await this.resolveLarkUser(senderId);
    const larkNames = [senderName, ...larkUser.names].filter(
      (value): value is string => Boolean(value),
    );
    if (
      !userKey ||
      !meegleNames.length ||
      !identitiesMatch({
        ...(email ? { meegleEmail: email } : {}),
        meegleNames,
        larkEmails: larkUser.emails,
        larkNames,
      })
    ) {
      await this.meegle(profile, ["auth", "logout", "--format", "json"]);
      return {
        kind: "blocked",
        reply: "授权账号与当前飞书消息发送者不一致，绑定已撤销。请使用你本人的飞书账号重新发起工单并完成授权。",
      };
    }

    const binding: StoredBinding = {
      senderId,
      profile,
      userKey,
      name: meegleNames[0]!,
      ...(email ? { email } : {}),
      verifiedAt: Date.now(),
    };
    await this.writePrivate(this.bindingPath(profile), binding);
    await this.archivePending(profile);
    return {
      kind: "blocked",
      reply: `个人授权已验证：${binding.name}。请重新发送原始工单和附件；此后新工单的系统“创建人”将显示为你。`,
    };
  }

  private async resolveLarkUser(senderId: string): Promise<{
    names: string[];
    emails: string[];
  }> {
    const profile = this.config.lark.cliProfile;
    if (!profile) throw new Error("LARK_CLI_PROFILE is required for identity verification");
    const result = await this.runner(this.config.lark.cliBin, [
      "--profile",
      profile,
      "contact",
      "+search-user",
      "--user-ids",
      senderId,
      "--as",
      "user",
      "--format",
      "json",
    ]);
    if (result.exitCode !== 0) {
      const reason =
        result.exitCode === null
          ? "process timed out"
          : safeAuthReason({}, result);
      throw new Error(
        `Unable to verify Lark sender identity${reason ? `: ${reason}` : ""}`,
      );
    }
    const payload = JSON.parse(result.stdout) as unknown;
    const objects: Array<Record<string, unknown>> = [];
    collectObjects(payload, objects);
    const matching = objects.filter((object) =>
      [object.open_id, object.openId, object.user_id].some((value) => value === senderId)
    );
    const source = matching.length ? matching : objects;
    const names = new Set<string>();
    const emails = new Set<string>();
    for (const object of source) {
      for (const key of [
        "name",
        "name_cn",
        "name_en",
        "en_name",
        "display_name",
        "localized_name",
      ]) {
        const value = stringValue(object[key]);
        if (value) names.add(value);
      }
      for (const key of ["email", "enterprise_email", "work_email"]) {
        const value = stringValue(object[key]);
        if (value) emails.add(value);
      }
    }
    if (!names.size && !emails.size) throw new Error("Lark sender identity was not returned");
    return { names: [...names], emails: [...emails] };
  }

  private async meegle(
    profile: string,
    args: string[],
    requireSuccess = false,
    timeoutMs?: number,
  ): Promise<ProcessResult> {
    const result = await this.runner(this.config.meegleIdentity.bin, [
      "--profile",
      profile,
      ...args,
    ], timeoutMs);
    const failure = requireSuccess ? responseError(result) : undefined;
    if (failure) {
      throw new Error(
        `Meegle CLI failed while running ${args.slice(0, 2).join(" ")}: ${failure}`,
      );
    }
    return result;
  }

  private pendingPath(profile: string): string {
    return join(this.directory, `${profile}.pending.json`);
  }

  private bindingPath(profile: string): string {
    return join(this.directory, `${profile}.binding.json`);
  }

  private async readPending(profile: string): Promise<PendingAuthorization | undefined> {
    try {
      return JSON.parse(await readFile(this.pendingPath(profile), "utf8")) as PendingAuthorization;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async readBinding(profile: string): Promise<StoredBinding | undefined> {
    try {
      return JSON.parse(await readFile(this.bindingPath(profile), "utf8")) as StoredBinding;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writePrivate(path: string, value: unknown): Promise<void> {
    await writeFile(path, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
  }

  private async archivePending(profile: string): Promise<void> {
    await rm(this.pendingPath(profile), { force: true });
  }
}
