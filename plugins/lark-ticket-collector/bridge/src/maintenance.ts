import { rmdir, unlink } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import type { BridgeConfig } from "./config.js";
import type { BridgeStore } from "./store.js";

export interface MaintenanceResult {
  expiredDrafts: number;
  deletedFiles: number;
  missingFiles: number;
  rejectedPaths: number;
  audit: ReturnType<BridgeStore["pruneAudit"]>;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path !== "" && !path.startsWith("..") && !path.startsWith("/");
}

export async function runMaintenance(input: {
  config: BridgeConfig;
  store: BridgeStore;
  now?: number;
}): Promise<MaintenanceResult> {
  const now = input.now ?? Date.now();
  const expiredDrafts = input.store.expireDrafts(now);
  const stale = input.store.staleResourceRecords(
    now - input.config.maintenance.resourceRetentionMs,
  );
  let deletedFiles = 0;
  let missingFiles = 0;
  let rejectedPaths = 0;

  for (const resource of stale) {
    if (!isWithin(input.config.storage.resourceDir, resource.localPath)) {
      rejectedPaths += 1;
      continue;
    }
    try {
      await unlink(resource.localPath);
      deletedFiles += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missingFiles += 1;
    }
    input.store.deleteResourceRecord(resource.id);
    const parent = dirname(resource.localPath);
    if (isWithin(input.config.storage.resourceDir, parent)) {
      await rmdir(parent).catch((error: NodeJS.ErrnoException) => {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error.code ?? "")) throw error;
      });
    }
  }

  const audit = input.store.pruneAudit(now - input.config.maintenance.auditRetentionMs);
  return { expiredDrafts, deletedFiles, missingFiles, rejectedPaths, audit };
}
