import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface BrokerRequest {
  token: string;
  args: string[];
}

interface BrokerResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface MeegleBrokerCapability {
  directory: string;
  token: string;
}

export interface MeegleBrokerAuditEntry {
  tool: "meegle";
  operation: string;
  exitCode: number;
  policyDenied: boolean;
}

const MAX_ARGUMENTS = 200;
const MAX_ARGUMENT_LENGTH = 100_000;

function pause(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export function meegleBrokerPolicyError(args: string[]): string | undefined {
  if (!args.length) return "Meegle command is required";
  if (args.length > MAX_ARGUMENTS) return "Too many Meegle arguments";
  if (args.some((argument) => argument.length > MAX_ARGUMENT_LENGTH)) {
    return "Meegle argument is too large";
  }
  if (args.some((argument) => argument === "--profile" || argument.startsWith("--profile="))) {
    return "--profile is managed by the ticket bridge";
  }
  if (args[0] === "auth" && args[1] !== "status") {
    return "Meegle authentication is managed by the ticket bridge";
  }
  if (args[0] === "config") {
    return "Meegle configuration is managed by the ticket bridge";
  }
  if (args[0] === "attachment" && ["+upload", "prepare-upload"].includes(args[1] ?? "")) {
    return "attachment writes are managed by the ticket bridge";
  }
  if (
    args[0] === "workitem" &&
    args[1] === "update" &&
    args.some((argument) => /file_?token/i.test(argument))
  ) {
    return "attachment field writes are managed by the ticket bridge";
  }
  if (
    args[0] === "workflow" &&
    args[1] === "update-node" &&
    args.some((argument) => /node[_-]?owners?/i.test(argument))
  ) {
    return "customer intake owner writes are managed by the ticket bridge";
  }
  return undefined;
}

function runMeegle(input: {
  binary: string;
  profile: string;
  args: string[];
  timeoutMs: number;
}): Promise<BrokerResponse> {
  return new Promise((resolve) => {
    const child = spawn(input.binary, ["--profile", input.profile, ...input.args], {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (response: BrokerResponse): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(response);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      finish({ exitCode: 124, stdout, stderr: `${stderr}\nMeegle broker command timed out`.trim() });
    }, input.timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on("error", (error) => {
      finish({ exitCode: 127, stdout, stderr: error.message });
    });
    child.on("close", (exitCode) => {
      finish({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

export class MeegleBrokerSession {
  readonly capability: MeegleBrokerCapability;
  readonly audit: MeegleBrokerAuditEntry[] = [];
  private stopping = false;

  constructor(
    private readonly input: {
      directory: string;
      binary: string;
      profile: string;
      commandTimeoutMs: number;
    },
  ) {
    this.capability = {
      directory: input.directory,
      token: randomBytes(32).toString("hex"),
    };
  }

  async prepare(): Promise<void> {
    await mkdir(this.input.directory, { recursive: true, mode: 0o700 });
  }

  stop(): void {
    this.stopping = true;
  }

  async run(): Promise<void> {
    await this.prepare();
    while (!this.stopping) {
      const names = await readdir(this.input.directory).catch(() => [] as string[]);
      const requests = names.filter((name) => /^request-[a-f0-9-]+\.json$/i.test(name));
      if (!requests.length) {
        await pause(25);
        continue;
      }
      for (const name of requests) await this.process(name);
    }
  }

  private async process(name: string): Promise<void> {
    const requestPath = join(this.input.directory, name);
    const processingPath = `${requestPath}.processing`;
    try {
      await rename(requestPath, processingPath);
    } catch {
      return;
    }
    const id = name.slice("request-".length, -".json".length);
    const responsePath = join(this.input.directory, `response-${id}.json`);
    const responseTempPath = `${responsePath}.tmp`;
    let response: BrokerResponse;
    let operation = "unknown";
    let policyDenied = false;
    try {
      const request = JSON.parse(await readFile(processingPath, "utf8")) as BrokerRequest;
      if (Array.isArray(request.args)) {
        operation =
          request.args
            .slice(0, 2)
            .filter((value) => typeof value === "string")
            .join(" ") || "unknown";
      }
      if (request.token !== this.capability.token) {
        response = { exitCode: 77, stdout: "", stderr: "Invalid Meegle broker capability" };
        policyDenied = true;
      } else if (!Array.isArray(request.args) || !request.args.every((value) => typeof value === "string")) {
        response = { exitCode: 64, stdout: "", stderr: "Invalid Meegle broker request" };
        policyDenied = true;
      } else {
        const policyError = meegleBrokerPolicyError(request.args);
        policyDenied = Boolean(policyError);
        response = policyError
          ? { exitCode: 64, stdout: "", stderr: policyError }
          : await runMeegle({
              binary: this.input.binary,
              profile: this.input.profile,
              args: request.args,
              timeoutMs: this.input.commandTimeoutMs,
            });
      }
    } catch (error) {
      response = {
        exitCode: 70,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    this.audit.push({
      tool: "meegle",
      operation,
      exitCode: response.exitCode,
      policyDenied,
    });
    await writeFile(responseTempPath, JSON.stringify(response), { mode: 0o600 });
    await rename(responseTempPath, responsePath);
    await rm(processingPath, { force: true });
  }
}
