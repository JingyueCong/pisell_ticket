#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.env.MEEGLE_BROKER_DIR;
const token = process.env.MEEGLE_BROKER_TOKEN;
const timeoutMs = Number(process.env.MEEGLE_BROKER_TIMEOUT_MS ?? "300000");
if (!directory || !token) {
  process.stderr.write("Meegle broker capability is required\n");
  process.exit(64);
}

await mkdir(directory, { recursive: true });
const id = randomUUID();
const requestPath = join(directory, `request-${id}.json`);
const requestTempPath = `${requestPath}.tmp`;
const responsePath = join(directory, `response-${id}.json`);
await writeFile(requestTempPath, JSON.stringify({ token, args: process.argv.slice(2) }), {
  mode: 0o600,
});
await rename(requestTempPath, requestPath);

const deadline = Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 300_000);
let response;
while (Date.now() < deadline) {
  try {
    response = JSON.parse(await readFile(responsePath, "utf8"));
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}
await Promise.all([rm(requestPath, { force: true }), rm(responsePath, { force: true })]);
if (!response) {
  process.stderr.write("Meegle broker response timed out\n");
  process.exit(124);
}
if (typeof response.stdout === "string") process.stdout.write(response.stdout);
if (typeof response.stderr === "string") process.stderr.write(response.stderr);
process.exit(Number.isInteger(response.exitCode) ? response.exitCode : 1);
