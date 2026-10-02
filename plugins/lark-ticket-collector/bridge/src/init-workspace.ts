import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

async function copyChecked(source: string, target: string): Promise<void> {
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const [sourceBytes, targetBytes] = await Promise.all([
      readFile(source),
      readFile(target),
    ]);
    if (!sourceBytes.equals(targetBytes)) {
      throw new Error(`Refusing to overwrite existing file: ${target}`);
    }
  }
}

async function main(): Promise<void> {
  const targetArg = process.argv[2];
  if (!targetArg) {
    throw new Error("Usage: npm run workspace:init -- /absolute/path/to/workspace");
  }
  const target = resolve(targetArg);
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "workspace");
  const configTarget = join(target, ".ticket-collector", "configuration");
  await mkdir(configTarget, { recursive: true });
  await copyChecked(join(sourceRoot, "AGENTS.md"), join(target, "AGENTS.md"));
  const configSource = join(sourceRoot, "configuration");
  for (const entry of await readdir(configSource, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    await copyChecked(join(configSource, entry.name), join(configTarget, entry.name));
  }
  process.stdout.write(`Initialized ticket collector workspace: ${target}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
