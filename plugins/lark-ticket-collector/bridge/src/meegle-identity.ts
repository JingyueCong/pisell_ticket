import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BridgeConfig } from "./config.js";
import type { MeegleRequestIdentity } from "./types.js";

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
    if (requireSuccess && result.exitCode !== 0) {
      throw new Error(`Meegle CLI failed while running ${args.slice(0, 2).join(" ")}`);
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
