import { createServer, type Server } from "node:http";
import { mkdir } from "node:fs/promises";

import { CodexCliBackend } from "./codex-backend.js";
import { loadConfig } from "./config.js";
import { LarkTicketService } from "./lark-service.js";
import { logger } from "./logger.js";
import { MeegleIdentityManager } from "./meegle-identity.js";
import { BridgeStore } from "./store.js";
import { VisitRecordLoader } from "./visit-record.js";

function startHealthServer(input: {
  host: string;
  port: number;
  isReady: () => boolean;
}): Server | undefined {
  if (input.port === 0) return undefined;
  const server = createServer((request, response) => {
    if (request.url !== "/healthz") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }
    const ready = input.isReady();
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: ready }));
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
  const visitRecordLoader = config.lark.visitRecordChatIds.length
    ? new VisitRecordLoader(config)
    : undefined;
  const service = new LarkTicketService(
    config,
    store,
    agent,
    identityManager,
    visitRecordLoader,
  );
  let ready = false;
  let shuttingDown = false;
  const health = startHealthServer({
    ...config.health,
    isReady: () => ready,
  });

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
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

  await service.connect();
  ready = true;
  logger.info("service.ready", {
    allowedChatCount: config.lark.allowedChatIds.length,
    allowedSenderCount: config.lark.allowedSenderIds.length,
    perUserMeegleAuth: config.meegleIdentity.enabled,
    visitRecordChatCount: config.lark.visitRecordChatIds.length,
    workspace: config.codex.workspace,
  });
}

main().catch((error: unknown) => {
  logger.error("service.start_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
