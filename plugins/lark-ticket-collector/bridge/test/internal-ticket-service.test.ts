import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BridgeConfig } from "../src/config.js";
import { parseInternalCustomerTicketRequest } from "../src/internal-api.js";
import {
  InternalTicketService,
  resolveInternalEvidenceResources,
} from "../src/internal-ticket-service.js";
import { BridgeStore } from "../src/store.js";
import type { AgentBackend, AgentRequest, AgentResult } from "../src/types.js";

function config(directory: string): BridgeConfig {
  return {
    lark: {
      appId: "cli_test",
      appSecret: "secret",
      cliBin: "lark-cli",
      allowedChatIds: [],
      visitRecordChatIds: [],
      visitRecordAllGroups: false,
      allowedSenderIds: [],
      requireMention: true,
      opsAlertCooldownMs: 300_000,
    },
    meegleIdentity: {
      enabled: false,
      bin: "meegle",
      host: "project.feishu.cn",
      projectKey: "v2qint",
      profileOverrides: new Map(),
    },
    codex: {
      bin: "codex",
      workspace: "/tmp/workspace",
      timeoutMs: 180_000,
      probeTimeoutMs: 30_000,
      probeIntervalMs: 1_800_000,
      probeFailureThreshold: 2,
      maxConcurrentRuns: 2,
    },
    storage: {
      dataDir: directory,
      dbPath: join(directory, "bridge.sqlite"),
      resourceDir: join(directory, "resources"),
    },
    limits: {
      maxReplyChars: 12_000,
      maxHistoryMessages: 12,
      maxHistoryAgeMs: 30 * 24 * 60 * 60_000,
      draftTtlMs: 7 * 24 * 60 * 60_000,
      maxResourceBytes: 25 * 1024 * 1024,
    },
    health: { host: "127.0.0.1", port: 0 },
    internalApi: {
      enabled: true,
      token: "a-secure-test-token-with-24-characters",
      submitterSenderId: "ou_ticket_service",
      submitterName: "Echo",
      attachmentRoots: [directory],
    },
    maintenance: {
      resourceRetentionMs: 30 * 24 * 60 * 60_000,
      auditRetentionMs: 180 * 24 * 60 * 60_000,
      intervalMs: 60 * 60_000,
    },
  };
}

class FakeAgent implements AgentBackend {
  readonly requests: AgentRequest[] = [];

  async run(request: AgentRequest): Promise<AgentResult> {
    this.requests.push(request);
    return {
      text: "已创建客服工单：https://example.invalid/customer/123",
      draft: {
        action: "close",
        ticketType: "客服工单",
        missingFields: [],
        workItemIds: ["123"],
      },
      workItemOutcomes: [
        { workItemId: "123", role: "customer", disposition: "created" },
      ],
      attachmentArchive: {
        status: "not_applicable",
        expectedBindings: 0,
        verifiedBindings: 0,
        targets: [],
      },
      diagnostics: [],
    };
  }
}

test("internal handoff forces customer-only routing and is idempotent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-internal-"));
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  const agent = new FakeAgent();
  const service = new InternalTicketService(config(directory), store, agent);
  const request = parseInternalCustomerTicketRequest({
    request_id: "om_support_1",
    conversation_id: "oc_customer:ou_customer",
    source_chat_id: "oc_customer",
    source_message_id: "om_support_1",
    sender_name: "测试员工",
    merchant_name: "青禾便当",
    problem_source: "Zendesk 工单系统（含电话、Chat、留言）",
    issue_type: "内部跟进处理",
    rating: "三星",
    content: "收银机无法打印小票，怎么处理？",
    context: [{ role: "user", content: "商户是青禾便当" }],
  });

  try {
    const first = await service.process(request);
    const second = await service.process(request);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.deepEqual(first.workItemIds, ["123"]);
    assert.equal(agent.requests.length, 1);
    const envelope = agent.requests[0]!.envelope;
    assert.deepEqual(envelope.routePolicy, {
      mode: "customer_only",
      authoritative: true,
      reason: "trusted_customer_support_human_handoff",
    });
    assert.match(envelope.content, /只创建客服主单/);
    assert.match(envelope.content, /青禾便当/);
    assert.match(envelope.content, /Zendesk 工单系统/);
    assert.match(envelope.content, /内部跟进处理/);
    assert.match(envelope.content, /三星/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("internal request parser rejects undeclared routing overrides", () => {
  assert.throws(() =>
    parseInternalCustomerTicketRequest({
      request_id: "om_support_2",
      conversation_id: "conversation",
      source_chat_id: "oc_customer",
      source_message_id: "om_support_2",
      content: "问题",
      creation_scope: "customer_bundle",
    }),
  );
});

test("internal evidence is checksum-verified and passed to the customer-only agent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ticket-internal-evidence-"));
  const evidencePath = join(directory, "checkout-error.png");
  const bytes = Buffer.from("trusted customer screenshot");
  writeFileSync(evidencePath, bytes, { mode: 0o600 });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const request = parseInternalCustomerTicketRequest({
    request_id: "om_support_evidence_1",
    conversation_id: "support-session-1",
    source_chat_id: "support-web:support-session-1",
    source_message_id: "42",
    merchant_name: "青禾便当",
    content: "结账页面报错，请转人工",
    context: [],
    evidence: [
      {
        attachment_id: "11111111-1111-4111-8111-111111111111",
        kind: "image",
        file_name: "checkout-error.png",
        media_type: "image/png",
        size_bytes: bytes.length,
        sha256,
        storage_path: evidencePath,
        analysis_status: "ready",
        analysis_summary: "结账页面显示打印机连接失败。",
      },
    ],
  });
  const store = new BridgeStore(join(directory, "bridge.sqlite"));
  const agent = new FakeAgent();
  try {
    const resources = await resolveInternalEvidenceResources(request, config(directory));
    assert.deepEqual(resources, [
      {
        type: "image",
        fileKey: "support-evidence:11111111-1111-4111-8111-111111111111",
        fileName: "checkout-error.png",
        localPath: realpathSync(evidencePath),
        sha256,
        size: bytes.length,
      },
    ]);

    const service = new InternalTicketService(config(directory), store, agent);
    const result = await service.process(request);
    assert.equal(result.draftOpen, true);
    assert.match(result.reply, /附件尚未全部写入/);
    assert.deepEqual(agent.requests[0]!.envelope.resources, resources);
    assert.match(agent.requests[0]!.envelope.content, /必须归档到客服工单附件字段/);
    assert.match(agent.requests[0]!.envelope.content, /结账页面显示打印机连接失败/);

    const tampered = {
      ...request,
      evidence: [{ ...request.evidence[0]!, sha256: "0".repeat(64) }],
    };
    await assert.rejects(
      resolveInternalEvidenceResources(tampered, config(directory)),
      /checksum mismatch/,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
