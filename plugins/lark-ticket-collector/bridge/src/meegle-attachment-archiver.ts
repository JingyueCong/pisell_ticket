import { spawn } from "node:child_process";
import { basename } from "node:path";

import type { BridgeConfig } from "./config.js";
import type {
  AttachmentArchiveReport,
  AttachmentArchiveTarget,
  DownloadedResource,
  MeegleRequestIdentity,
  WorkItemOutcome,
} from "./types.js";

export interface AttachmentProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type AttachmentProcessRunner = (
  executable: string,
  args: string[],
  timeoutMs?: number,
) => Promise<AttachmentProcessResult>;

interface AttachmentDescriptor {
  name: string;
  type: string;
  size: string;
  fileToken: string;
}

function runProcess(
  executable: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<AttachmentProcessResult> {
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

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function parseObjectJson(text: string, context: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${context} returned invalid JSON`);
  }
  const object = asObject(parsed);
  if (!object) throw new Error(`${context} returned a non-object JSON response`);
  return object;
}

export function normalizeUploadedAttachment(payload: unknown): AttachmentDescriptor {
  const object = asObject(payload);
  if (!object) throw new Error("Attachment upload returned a non-object payload");
  const name = nonEmptyString(object.name);
  const type = nonEmptyString(object.mime_type);
  const size = nonEmptyString(object.size);
  const fileToken = nonEmptyString(object.file_token);
  if (!name || !type || !size || !fileToken) {
    throw new Error("Attachment upload response is missing name, mime_type, size, or file_token");
  }
  // This whitelist is intentional. Meegle rejects attachment-field values
  // containing the upload endpoint's file_url/file_token keys or other IDs.
  return { name, type, size, fileToken };
}

function normalizeStoredAttachment(value: unknown): AttachmentDescriptor | undefined {
  const object = asObject(value);
  if (!object) return undefined;
  const name = nonEmptyString(object.name);
  const type = nonEmptyString(object.type ?? object.mime_type);
  const size = nonEmptyString(object.size);
  const fileToken = nonEmptyString(object.fileToken ?? object.file_token);
  if (!name || !type || !size || !fileToken) return undefined;
  return { name, type, size, fileToken };
}

function parseMaybeJson(value: unknown): unknown {
  let current = value;
  for (let index = 0; index < 3 && typeof current === "string"; index += 1) {
    const text = current.trim();
    if (!(text.startsWith("[") || text.startsWith("{"))) break;
    try {
      current = JSON.parse(text) as unknown;
    } catch {
      break;
    }
  }
  return current;
}

function attachmentArray(value: unknown): AttachmentDescriptor[] {
  return rawAttachmentArray(value)
    .map(normalizeStoredAttachment)
    .filter((item): item is AttachmentDescriptor => Boolean(item));
}

function rawAttachmentArray(value: unknown): Array<Record<string, unknown>> {
  const parsed = parseMaybeJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(asObject)
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function collectObjects(value: unknown, target: Array<Record<string, unknown>>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectObjects(child, target);
    return;
  }
  const object = asObject(value);
  if (!object) return;
  target.push(object);
  for (const child of Object.values(object)) collectObjects(child, target);
}

export function extractAttachmentField(
  payload: unknown,
  fieldKey: string,
): AttachmentDescriptor[] {
  return extractRawAttachmentField(payload, fieldKey)
    .map(normalizeStoredAttachment)
    .filter((item): item is AttachmentDescriptor => Boolean(item));
}

export function extractRawAttachmentField(
  payload: unknown,
  fieldKey: string,
): Array<Record<string, unknown>> {
  const root = asObject(payload);
  if (!root) return [];

  const fields = asObject(root.fields);
  if (fields && Object.hasOwn(fields, fieldKey)) {
    return rawAttachmentArray(fields[fieldKey]);
  }

  const objects: Array<Record<string, unknown>> = [];
  collectObjects(root, objects);
  for (const object of objects) {
    const mappedFields = asObject(object.fields);
    if (mappedFields && Object.hasOwn(mappedFields, fieldKey)) {
      return rawAttachmentArray(mappedFields[fieldKey]);
    }
    if (Object.hasOwn(object, fieldKey)) {
      const attachments = rawAttachmentArray(object[fieldKey]);
      if (attachments.length || Array.isArray(parseMaybeJson(object[fieldKey]))) {
        return attachments;
      }
    }
    const key = nonEmptyString(object.field_key ?? object.fieldKey ?? object.key);
    if (key !== fieldKey) continue;
    for (const candidate of [object.field_value, object.fieldValue, object.value]) {
      const attachments = rawAttachmentArray(candidate);
      if (attachments.length || Array.isArray(parseMaybeJson(candidate))) return attachments;
    }
  }
  return [];
}

function includesAttachment(
  current: Array<Record<string, unknown>>,
  expected: AttachmentDescriptor,
): boolean {
  return current.some((raw) => {
    const normalized = normalizeStoredAttachment(raw);
    if (!normalized) return false;
    return (
      normalized.fileToken === expected.fileToken ||
      (normalized.name === expected.name && normalized.size === expected.size)
    );
  });
}

function readableResources(resources: DownloadedResource[]): DownloadedResource[] {
  const result: DownloadedResource[] = [];
  const seen = new Set<string>();
  for (const resource of resources) {
    if (!resource.localPath || resource.error || !resource.fileName || resource.size === undefined) {
      continue;
    }
    const identity = resource.sha256 ?? resource.localPath;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(resource);
  }
  return result;
}

function committedIds(outcomes: WorkItemOutcome[]): Set<string> {
  return new Set(
    outcomes
      .filter((outcome) => outcome.disposition !== "queried")
      .map((outcome) => outcome.workItemId),
  );
}

export class MeegleAttachmentArchiver {
  constructor(
    private readonly config: BridgeConfig,
    private readonly runner: AttachmentProcessRunner = runProcess,
  ) {}

  async archive(input: {
    identity: MeegleRequestIdentity;
    targets: AttachmentArchiveTarget[];
    resources: DownloadedResource[];
    workItemOutcomes: WorkItemOutcome[];
  }): Promise<AttachmentArchiveReport> {
    const resources = readableResources(input.resources);
    const allowedIds = committedIds(input.workItemOutcomes);
    const targets = input.targets.filter(
      (target) => allowedIds.has(target.workItemId) && Boolean(target.fieldKey),
    );
    if (!resources.length || !targets.length) {
      return {
        status: resources.length ? "pending" : "not_applicable",
        expectedBindings: resources.length * targets.length,
        verifiedBindings: 0,
        targets: targets.map((target) => ({ ...target, expectedFiles: resources.length, verifiedFiles: 0 })),
        note: resources.length
          ? "Bridge 未收到可归档的已提交工作项目标字段"
          : "没有可读取的业务附件",
      };
    }

    const reports: AttachmentArchiveTarget[] = [];
    const failures: string[] = [];
    for (const target of targets) {
      try {
        const verifiedFiles = await this.archiveTarget({
          identity: input.identity,
          target,
          resources,
        });
        reports.push({
          workItemId: target.workItemId,
          fieldKey: target.fieldKey,
          expectedFiles: resources.length,
          verifiedFiles,
        });
      } catch (error) {
        reports.push({
          workItemId: target.workItemId,
          fieldKey: target.fieldKey,
          expectedFiles: resources.length,
          verifiedFiles: 0,
        });
        failures.push(
          `#${target.workItemId}/${target.fieldKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const expectedBindings = reports.reduce((sum, target) => sum + target.expectedFiles, 0);
    const verifiedBindings = reports.reduce((sum, target) => sum + target.verifiedFiles, 0);
    const verified = expectedBindings > 0 && verifiedBindings === expectedBindings;
    return {
      status: verified ? "verified" : "failed",
      expectedBindings,
      verifiedBindings,
      targets: reports,
      note: verified
        ? `Bridge 已逐项写入并回读验证 ${verifiedBindings}/${expectedBindings} 个附件绑定`
        : failures.join("；").slice(0, 1_000) || "Bridge 附件回读验证未完成",
    };
  }

  private async archiveTarget(input: {
    identity: MeegleRequestIdentity;
    target: AttachmentArchiveTarget;
    resources: DownloadedResource[];
  }): Promise<number> {
    let verifiedFiles = 0;
    for (const resource of input.resources) {
      const beforeUpload = await this.readRawField(
        input.identity.profile,
        input.target.workItemId,
        input.target.fieldKey,
      );
      const expectedExisting = {
        name: basename(resource.localPath!),
        type: "application/octet-stream",
        size: String(resource.size),
        fileToken: "not-yet-uploaded",
      };
      if (includesAttachment(beforeUpload, expectedExisting)) {
        verifiedFiles += 1;
        continue;
      }

      const result = await this.meegle(input.identity.profile, [
        "attachment",
        "+upload",
        resource.localPath!,
        "--resource-type",
        "15",
        "--project-key",
        this.config.meegleIdentity.projectKey,
        "--work-item-id",
        input.target.workItemId,
        "--field-key",
        input.target.fieldKey,
        "--format",
        "json",
      ]);
      const uploaded = normalizeUploadedAttachment(
        parseObjectJson(result.stdout, "attachment +upload"),
      );

      let appended = false;
      let lastError: unknown;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const current = await this.readRawField(
          input.identity.profile,
          input.target.workItemId,
          input.target.fieldKey,
        );
        if (includesAttachment(current, uploaded)) {
          appended = true;
          break;
        }
        const params = JSON.stringify({
          fields: [
            {
              field_key: input.target.fieldKey,
              // Existing server objects are deliberately kept byte-for-byte at
              // the property level. They may include uid/url fields required by
              // the backend and must not be downgraded to the upload shape.
              field_value: JSON.stringify([...current, uploaded]),
            },
          ],
        });
        try {
          await this.meegle(input.identity.profile, [
            "workitem",
            "update",
            "--project-key",
            this.config.meegleIdentity.projectKey,
            "--work-item-id",
            input.target.workItemId,
            "--params",
            params,
            "--format",
            "json",
          ]);
        } catch (error) {
          lastError = error;
        }
        const verified = await this.readRawField(
          input.identity.profile,
          input.target.workItemId,
          input.target.fieldKey,
        );
        if (includesAttachment(verified, uploaded)) {
          appended = true;
          break;
        }
      }
      if (!appended) {
        throw lastError instanceof Error
          ? lastError
          : new Error(`附件 ${uploaded.name} 在两次逐项追加后仍未回读成功`);
      }
      verifiedFiles += 1;
    }
    return verifiedFiles;
  }

  private async readRawField(
    profile: string,
    workItemId: string,
    fieldKey: string,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.meegle(profile, [
      "workitem",
      "get",
      "--project-key",
      this.config.meegleIdentity.projectKey,
      "--work-item-id",
      workItemId,
      "--fields",
      fieldKey,
      "--format",
      "json",
    ]);
    return extractRawAttachmentField(parseObjectJson(result.stdout, "workitem get"), fieldKey);
  }

  private async meegle(profile: string, args: string[]): Promise<AttachmentProcessResult> {
    const result = await this.runner(
      this.config.meegleIdentity.bin,
      ["--profile", profile, ...args],
      60_000,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `Meegle ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
      );
    }
    return result;
  }
}
