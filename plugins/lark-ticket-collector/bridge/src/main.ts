import { createServer, type Server } from "node:http";
import { mkdir } from "node:fs/promises";

import {
  CodexCliBackend,
  CodexRuntimeCompatibilityError,
} from "./codex-backend.js";
import { loadConfig } from "./config.js";
import { LarkTicketService } from "./lark-service.js";
import { logger } from "./logger.js";
import { MeegleIdentityManager } from "./meegle-identity.js";
import { BridgeStore } from "./store.js";
import { VisitRecordLoader } from "./visit-record.js";

function startHealthServer(input: {
  host: string;
  port: number;
  status: () => { ready: boolean; reason?: string };
}): Server | undefined {
  if (input.port === 0) return undefined;
  const server = createServer((request, response) => {
    if (request.url !== "/healthz") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }
    const status = input.status();
    response.writeHead(status.ready ? 200 : 503, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify({
        ok: status.ready,
        ...(!status.ready && status.reason ? { reason: status.reason } : {}),
      }),
    );
  });
  server.listen(input.port, input.host, () => {
    logger.info("health.listening", { host: input.host, port: input.port });
  });
  return server;
}

async function main(): Promise<void> {
  const config = loadConfig();
  await Promise.all([
    mkdir(config.storage.dataDir, { recursive: true }),
    mkdir(config.storage.resourceDir, { recursive: true }),
  ]);

  const store = new BridgeStore(config.storage.dbPath);
  const agent = new CodexCliBackend(config);
  const identityManager = config.meegleIdentity.enabled
    ? new MeegleIdentityManager(config)
    : undefined;
  const visitRecordLoader =
    config.lark.visitRecordAllGroups || config.lark.visitRecordChatIds.length
    ? new VisitRecordLoader(config)
    : undefined;
  const service = new LarkTicketService(
    config,
    store,
    agent,
    identityManager,
    visitRecordLoader,
  );
  let healthStatus: { ready: boolean; reason?: string } = {
    ready: false,
    reason: "starting",
  };
  let shuttingDown = false;
  const health = startHealthServer({
    ...config.health,
    status: () => healthStatus,
  });

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    healthStatus = { ready: false, reason: "stopping" };
    logger.info("service.stopping", { signal });
    health?.close();
    await service.disconnect().catch((error: unknown) => {
      logger.warn("lark.disconnect_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    store.close();
    logger.info("service.stopped");
  };

  process.once("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));

  let startupStage: "codex_probe" | "lark_connect" = "codex_probe";
  try {
    const probe = await agent.probe();
    logger.info("codex.runtime_probe_ready", { durationMs: probe.durationMs });
    startupStage = "lark_connect";
    await service.connect();
  } catch (error) {
    healthStatus = {
      ready: false,
      reason:
        error instanceof CodexRuntimeCompatibilityError
          ? "codex_runtime_probe_failed"
          : startupStage === "lark_connect"
            ? "lark_connect_failed"
            : "service_start_failed",
    };
    logger.error("service.not_ready", {
      stage: startupStage,
      reason: healthStatus.reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  healthStatus = { ready: true };
  logger.info("service.ready", {
    allowedChatCount: config.lark.allowedChatIds.length,
    allowedSenderCount: config.lark.allowedSenderIds.length,
    perUserMeegleAuth: config.meegleIdentity.enabled,
    visitRecordChatCount: config.lark.visitRecordChatIds.length,
    visitRecordAllGroups: config.lark.visitRecordAllGroups,
    workspace: config.codex.workspace,
  });
}

main().catch((error: unknown) => {
  logger.error("service.start_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
