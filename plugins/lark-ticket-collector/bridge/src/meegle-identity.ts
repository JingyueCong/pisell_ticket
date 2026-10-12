import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BridgeConfig } from "./config.js";
import type {
  ContentProducerAssignment,
  CustomerCrmCandidate,
  CustomerCrmResolution,
  MeegleRequestIdentity,
} from "./types.js";

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

export type IdentityGateResult =
  | { kind: "authorized"; identity: MeegleRequestIdentity }
  | { kind: "blocked"; reply: string };

export interface CustomerNodeOwnerCorrection {
  nodeId: string;
  ownerUserKey: string;
}

const CUSTOMER_CRM_WORK_ITEM_TYPE = "67df84a32e42950cb0195cba";
const CUSTOMER_SERVICE_WORK_ITEM_TYPE = "6886d47112cff2ae4ae279e3";
const CONTENT_MAINTENANCE_WORK_ITEM_TYPE = "67df87a8baf45c9c247ba778";
const OWNER_READBACK_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000] as const;

export function isMeegleAuthorizationConfirmation(messageText: string): boolean {
  return /(已授权|授权完成|完成授权)/u.test(messageText);
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

function customerCrmCandidates(value: unknown, projectKey: string): CustomerCrmCandidate[] {
  const objects: Array<Record<string, unknown>> = [];
  collectObjects(value, objects);
  const found = new Map<string, CustomerCrmCandidate>();
  for (const object of objects) {
    const workItemId = ["work_item_id", "workItemId", "工作项ID", "工作项id", "id"]
      .map((key) => scalarValue(object[key]))
      .find(Boolean);
    const name = ["name", "名称", "title"]
      .map((key) => scalarValue(object[key]))
      .find(Boolean);
    if (!workItemId || !name || found.has(workItemId)) continue;
    const status = ["work_item_status", "workItemStatus", "状态", "status"]
      .map((key) => scalarValue(object[key]))
      .find(Boolean);
    found.set(workItemId, {
      workItemId,
      name,
      ...(status ? { status } : {}),
      url: `https://project.feishu.cn/${projectKey}/crm/detail/${workItemId}`,
    });
  }
  return [...found.values()].slice(0, 10);
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
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const profile = this.profileFor(input.senderId);
    const status = await this.meegle(profile, ["auth", "status", "--format", "json"]);
    const statusJson = status.exitCode === 0 ? parseJson(status.stdout) : {};
    if (statusJson.authenticated === true) {
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
      const refreshedStatus = await this.meegle(profile, ["auth", "status", "--format", "json"]);
      const refreshedJson =
        refreshedStatus.exitCode === 0 ? parseJson(refreshedStatus.stdout) : {};
      if (refreshedJson.authenticated !== true) {
        return {
          kind: "blocked",
          reply: "授权仍在等待完成。请完成个人授权后再次回复“已授权”。",
        };
      }
      return this.verifyAndBind(profile, input.senderId, input.senderName);
    }

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
    return {
      kind: "blocked",
      reply: [
        "首次使用需要绑定你本人的飞书项目身份，授权完成后系统“创建人”才会显示为你。",
        "",
        `[点击完成个人授权](${next.verification_uri_complete})`,
        `用户代码：${next.user_code}`,
        "",
        "完成后请在本消息下回复“已授权”，验证通过后再重新发送原始工单和附件。系统不会回退使用 Echo 身份。",
      ].join("\n"),
    };
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
      throw new Error("Unable to verify Lark sender identity");
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
  ): Promise<ProcessResult> {
    const result = await this.runner(this.config.meegleIdentity.bin, [
      "--profile",
      profile,
      ...args,
    ]);
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
