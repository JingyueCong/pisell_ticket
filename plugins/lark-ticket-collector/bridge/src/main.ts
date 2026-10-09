import { createServer, type Server } from "node:http";
import { chmod, mkdir } from "node:fs/promises";

import {
  CodexCliBackend,
  CodexRuntimeCompatibilityError,
} from "./codex-backend.js";
import { loadConfig } from "./config.js";
import { LarkTicketService } from "./lark-service.js";
import { logger } from "./logger.js";
import { runMaintenance } from "./maintenance.js";
import { MeegleIdentityManager } from "./meegle-identity.js";
import { BridgeStore } from "./store.js";
import { RuntimeMonitor } from "./runtime-monitor.js";
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
  process.umask(0o077);
  const config = loadConfig();
  await Promise.all([
    mkdir(config.storage.dataDir, { recursive: true, mode: 0o700 }),
    mkdir(config.storage.resourceDir, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(config.storage.dataDir, 0o700),
    chmod(config.storage.resourceDir, 0o700),
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
  service.setAccepting(false);
  let healthStatus: { ready: boolean; reason?: string } = {
    ready: false,
    reason: "starting",
  };
  let shuttingDown = false;
  let maintenanceTimer: NodeJS.Timeout | undefined;
  let runtimeMonitor: RuntimeMonitor | undefined;
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
    runtimeMonitor?.stop();
    if (maintenanceTimer) clearInterval(maintenanceTimer);
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
    await runMaintenance({ config, store })
      .then((maintenance) => logger.info("maintenance.completed", { ...maintenance }))
      .catch((error: unknown) => logger.error("maintenance.failed", {
        error: error instanceof Error ? error.message : String(error),
      }));
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
  service.setAccepting(true);
  runtimeMonitor = new RuntimeMonitor({
    intervalMs: config.codex.probeIntervalMs,
    failureThreshold: config.codex.probeFailureThreshold,
    shouldProbe: () => agent.canProbeWithoutDelay(),
    probe: async () => {
      await agent.probe();
    },
    onCheck: (result, detail) => {
      if (result === "passed") logger.info("codex.runtime_probe_passed");
      if (result === "skipped") logger.info("codex.runtime_probe_skipped_busy");
      if (result === "failed") {
        logger.warn("codex.runtime_probe_failed", {
          error: detail instanceof Error ? detail.message : String(detail),
        });
      }
    },
    onTransition: async (state, error) => {
      if (state === "unhealthy") {
        healthStatus = { ready: false, reason: "codex_runtime_probe_failed" };
        service.setAccepting(false);
        await service.sendOperationalAlert({
          key: "codex_runtime_unhealthy",
          markdown: [
            "**工单 Agent 已暂停接单**",
            `连续 ${config.codex.probeFailureThreshold} 次 Codex 运行探针失败。`,
            `错误：${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`,
            "暂停期间的新消息不会写入 Meegle；健康检查恢复后会自动重新接单。",
          ].join("\n"),
        });
      } else {
        healthStatus = { ready: true };
        service.setAccepting(true);
        await service.sendOperationalAlert({
          key: "codex_runtime_recovered",
          markdown: "**工单 Agent 已恢复**\nCodex 运行探针已通过，服务已自动恢复接单。",
        });
      }
    },
  });
  runtimeMonitor.start();
  maintenanceTimer = setInterval(() => {
    void runMaintenance({ config, store })
      .then((result) => logger.info("maintenance.completed", { ...result }))
      .catch((error: unknown) => logger.error("maintenance.failed", {
        error: error instanceof Error ? error.message : String(error),
      }));
  }, config.maintenance.intervalMs);
  maintenanceTimer.unref();
  logger.info("service.ready", {
    allowedChatCount: config.lark.allowedChatIds.length,
    allowedSenderCount: config.lark.allowedSenderIds.length,
    perUserMeegleAuth: config.meegleIdentity.enabled,
    visitRecordChatCount: config.lark.visitRecordChatIds.length,
    visitRecordAllGroups: config.lark.visitRecordAllGroups,
    workspace: config.codex.workspace,
    maxConcurrentCodexRuns: config.codex.maxConcurrentRuns,
    periodicProbeMs: config.codex.probeIntervalMs,
    opsAlertsConfigured: Boolean(config.lark.opsAlertChatId),
  });
}

main().catch((error: unknown) => {
  logger.error("service.start_failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
