import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Readable } from "node:stream";

import {
  createLarkChannel,
  LoggerLevel,
  type LarkChannel,
  type NormalizedMessage,
  type ResourceDescriptor,
} from "@larksuiteoapi/node-sdk";

import type { BridgeConfig } from "./config.js";
import { KeyedQueue } from "./keyed-queue.js";
import { deriveIntakeRoutePolicy } from "./intake-route.js";
import { logger } from "./logger.js";
import {
  isMeegleAuthorizationConfirmation,
  MeegleIdentityManager,
} from "./meegle-identity.js";
import { parseProducerNames } from "./producer-source.js";
import { conversationKey } from "./prompt.js";
import { BridgeStore } from "./store.js";
import type {
  AgentBackend,
  ContentMaintenanceProducerSource,
  DownloadedResource,
  InboundEnvelope,
  MeegleRequestIdentity,
  VisitRecordEvidence,
} from "./types.js";
import {
  extractMinuteLinks,
  isAutomaticVisitRecordMessage,
  VisitRecordError,
  VisitRecordLoader,
} from "./visit-record.js";

function safeName(resource: ResourceDescriptor, index: number): string {
  const fallbackExtension =
    resource.type === "image"
      ? ".png"
      : resource.type === "video"
        ? ".mp4"
        : resource.type === "audio"
          ? ".opus"
          : ".bin";
  const candidate = basename(resource.fileName || `attachment-${index + 1}${fallbackExtension}`);
  const sanitized = candidate.replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 180);
  return sanitized || `attachment-${index + 1}${fallbackExtension}`;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 40))}\n\n（回复过长，已截断）`;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function messageEvidenceText(message: NormalizedMessage): string {
  let raw = "";
  if (message.raw !== undefined) {
    try {
      raw = JSON.stringify(message.raw);
    } catch {
      raw = "";
    }
  }
  return [message.content, raw].filter(Boolean).join("\n");
}

function errorMessage(messageId: string): string {
  return [
    "这条工单消息处理失败，当前无法确认是否已经发生外部写入。",
    `消息 ID：${messageId}`,
    "为避免重复建单，机器人不会自动重试同一消息；请由管理员先核对 Meegle 后再重新发送。",
  ].join("\n");
}

export class LarkTicketService {
  readonly channel: LarkChannel;
  private readonly queue = new KeyedQueue();

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: BridgeStore,
    private readonly agent: AgentBackend,
    private readonly identityManager?: MeegleIdentityManager,
    private readonly visitRecordLoader?: VisitRecordLoader,
  ) {
    const allowedGroupIds = [
      ...new Set([
        ...config.lark.allowedChatIds,
        ...config.lark.visitRecordChatIds,
      ]),
    ];
    const policy = {
      ...(!config.lark.visitRecordAllGroups && allowedGroupIds.length
        ? { groupAllowlist: allowedGroupIds }
        : {}),
      dmMode: config.lark.allowedSenderIds.length ? ("allowlist" as const) : ("open" as const),
      ...(config.lark.allowedSenderIds.length
        ? { dmAllowlist: config.lark.allowedSenderIds }
        : {}),
      // Automatic visit-record groups need non-mention Minutes links to reach
      // the bridge. registerHandlers applies the narrower per-message gate.
      requireMention:
        config.lark.visitRecordAllGroups || config.lark.visitRecordChatIds.length
        ? false
        : config.lark.requireMention,
      respondToMentionAll: false,
    };

    this.channel = createLarkChannel({
      appId: config.lark.appId,
      appSecret: config.lark.appSecret,
      transport: "websocket",
      policy,
      // Minutes share cards can hide their URL in the raw card payload rather
      // than the normalized human-readable text.
      includeRawEvent: true,
      loggerLevel: LoggerLevel.info,
      handshakeTimeoutMs: 30_000,
      source: "pisell-ticket-collector",
      safety: {
        dedup: { ttl: 24 * 60 * 60_000, maxEntries: 20_000 },
        chatQueue: { enabled: true },
        staleMessageWindowMs: 15 * 60_000,
      },
      outbound: {
        textChunkLimit: Math.min(config.limits.maxReplyChars, 12_000),
        allowedFileDirs: [config.storage.resourceDir],
        retry: { maxAttempts: 2, baseDelayMs: 600 },
      },
    });

    this.registerHandlers();
  }

  async connect(): Promise<void> {
    await mkdir(this.config.storage.resourceDir, { recursive: true });
    await this.channel.connect();
  }

  async disconnect(): Promise<void> {
    await this.channel.disconnect();
  }

  private registerHandlers(): void {
    this.channel.on("message", (message) => {
      const automaticVisitRecord = isAutomaticVisitRecordMessage({
        chatId: message.chatId,
        chatType: message.chatType,
        content: messageEvidenceText(message),
        visitRecordChatIds: this.config.lark.visitRecordChatIds,
        visitRecordAllGroups: this.config.lark.visitRecordAllGroups,
      });
      const identityConfirmation = Boolean(
        this.identityManager &&
          message.replyToMessageId &&
          isMeegleAuthorizationConfirmation(message.content),
      );
      const configuredGroupIds = new Set([
        ...this.config.lark.allowedChatIds,
        ...this.config.lark.visitRecordChatIds,
      ]);
      if (
        message.chatType === "group" &&
        configuredGroupIds.size > 0 &&
        !configuredGroupIds.has(message.chatId) &&
        !automaticVisitRecord &&
        !identityConfirmation
      ) {
        return;
      }
      if (
        message.chatType === "group" &&
        this.config.lark.requireMention &&
        !message.mentionedBot &&
        !automaticVisitRecord &&
        !identityConfirmation
      ) {
        return;
      }
      if (
        this.config.lark.allowedSenderIds.length > 0 &&
        !this.config.lark.allowedSenderIds.includes(message.senderId)
      ) {
        logger.warn("message.sender_rejected", {
          messageId: message.messageId,
          chatId: message.chatId,
          senderId: message.senderId,
        });
        return;
      }

      // A sender owns one Meegle profile across every allowed chat. Serialize by
      // sender so two simultaneous chats cannot race the same OAuth/profile state.
      const key = message.senderId;
      void this.queue.enqueue(key, () => this.processMessage(message)).catch((error: unknown) => {
        logger.error("message.queue_error", {
          messageId: message.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    this.channel.on("reject", (event) => {
      logger.warn("message.rejected", {
        reason: event.reason,
        messageId: event.messageId,
        chatId: event.chatId,
        senderId: event.senderId,
      });
    });
    this.channel.on("error", (error) => {
      logger.error("lark.channel_error", { code: error.code, message: error.message });
    });
    this.channel.on("reconnecting", () => logger.warn("lark.reconnecting"));
    this.channel.on("reconnected", () => logger.info("lark.reconnected"));
  }

  private async processMessage(message: NormalizedMessage): Promise<void> {
    const automaticVisitRecord = isAutomaticVisitRecordMessage({
      chatId: message.chatId,
      chatType: message.chatType,
      content: messageEvidenceText(message),
      visitRecordChatIds: this.config.lark.visitRecordChatIds,
      visitRecordAllGroups: this.config.lark.visitRecordAllGroups,
    });
    const claimed = this.store.claimMessage({
      messageId: message.messageId,
      chatId: message.chatId,
      senderId: message.senderId,
    });
    if (!claimed) {
      logger.info("message.duplicate_ignored", { messageId: message.messageId });
      return;
    }

    logger.info("message.processing", {
      messageId: message.messageId,
      chatId: message.chatId,
      senderId: message.senderId,
      resourceCount: message.resources.length,
    });

    let meegleIdentity: MeegleRequestIdentity | undefined;
    if (this.identityManager) {
      try {
        const gate = await this.identityManager.authorize({
          senderId: message.senderId,
          ...(message.senderName ? { senderName: message.senderName } : {}),
          messageText: message.content,
        });
        if (gate.kind === "blocked") {
          this.store.completeMessage(message.messageId, gate.reply);
          await this.channel.send(
            message.chatId,
            { markdown: gate.reply },
            { replyTo: message.messageId },
          );
          logger.info("message.identity_blocked", {
            messageId: message.messageId,
            senderId: message.senderId,
          });
          return;
        }
        meegleIdentity = gate.identity;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const reply = [
          "暂时无法验证你的飞书项目身份，因此没有创建或修改任何工单。",
          "请联系管理员检查个人授权与飞书通讯录读取权限后，再发送一条新的工单消息。",
        ].join("\n");
        this.store.failMessage(message.messageId, reason);
        logger.error("message.identity_failed", {
          messageId: message.messageId,
          senderId: message.senderId,
          error: reason,
        });
        await this.channel.send(
          message.chatId,
          { markdown: reply },
          { replyTo: message.messageId },
        );
        return;
      }
    }

    try {
      await this.channel.send(
        message.chatId,
        {
          markdown:
            automaticVisitRecord
              ? "已识别上门服务会议记录，正在读取飞书智能纪要、匹配客户并生成客服工单。完成后会在此消息下回复。"
              : "已收到，正在处理工单。字段核验、查重和回读通常需要几分钟，完成后会在此消息下回复。",
        },
        { replyTo: message.messageId },
      );
    } catch (error) {
      logger.warn("message.ack_failed", {
        messageId: message.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const [resources, producerSource, visitRecord] = await Promise.all([
        this.downloadResources(message),
        this.readContentMaintenanceProducerSource(),
        automaticVisitRecord
          ? this.readVisitRecord(message)
          : Promise.resolve(undefined),
      ]);
      this.store.saveResources(message.messageId, resources);
      const envelope = this.toEnvelope(
        message,
        resources,
        producerSource,
        meegleIdentity,
        visitRecord,
      );
      const messageKey = conversationKey(envelope);
      const activeDraft = this.store.activeDraft({
        conversationKey: messageKey,
        chatId: envelope.chatId,
        senderId: envelope.senderId,
        allowParticipantFallback: !(
          envelope.threadId || envelope.rootId || envelope.replyToMessageId
        ),
      });
      const contextKey = activeDraft?.conversationKey ?? messageKey;
      const userTranscript = this.transcriptText(envelope);
      const history = this.store.recentConversation(
        contextKey,
        this.config.limits.maxHistoryMessages,
        Date.now() - this.config.limits.maxHistoryAgeMs,
      );
      const result = await this.agent.run({
        envelope,
        history,
        ...(activeDraft ? { activeDraft } : {}),
        resourceRoot: this.config.storage.resourceDir,
      });
      let resultText = result.text;
      const customerRoute =
        ["customer_bundle", "customer_only", "customer_auto"].includes(
          envelope.routePolicy?.mode ?? "",
        ) || /客服工单/u.test(result.draft.ticketType ?? activeDraft?.ticketType ?? "");
      const customerWorkItemId = result.draft.workItemIds[0];
      if (
        customerRoute &&
        customerWorkItemId &&
        meegleIdentity &&
        this.identityManager
      ) {
        try {
          const correction = await this.identityManager.ensureCustomerIntakeNodeOwner({
            identity: meegleIdentity,
            workItemId: customerWorkItemId,
          });
          logger.info("customer.intake_owner_verified", {
            messageId: message.messageId,
            workItemId: customerWorkItemId,
            nodeId: correction.nodeId,
            ownerUserKey: correction.ownerUserKey,
          });
        } catch (error) {
          logger.warn("customer.intake_owner_failed", {
            messageId: message.messageId,
            workItemId: customerWorkItemId,
            error: error instanceof Error ? error.message : String(error),
          });
          resultText = [
            resultText,
            "",
            `注意：客服工单 #${customerWorkItemId} 已保留，但“创建工单”节点负责人未能回读确认为当前提交员工；管理员只需校正该节点负责人，不要重复建单。`,
          ].join("\n");
        }
      }
      const reply = truncate(resultText, this.config.limits.maxReplyChars);
      const resultKey =
        result.draft.action === "update" || result.draft.action === "close"
          ? activeDraft?.conversationKey ?? messageKey
          : messageKey;
      this.store.addConversationMessage({
        conversationKey: resultKey,
        role: "user",
        content: userTranscript,
        sourceMessageId: message.messageId,
        createdAt: message.createTime,
      });
      this.store.addConversationMessage({
        conversationKey: resultKey,
        role: "assistant",
        content: reply,
        sourceMessageId: `response:${message.messageId}`,
      });
      this.store.applyDraftUpdate({
        conversationKey: resultKey,
        chatId: envelope.chatId,
        senderId: envelope.senderId,
        ...(activeDraft ? { activeDraftId: activeDraft.id } : {}),
        update: result.draft,
        resources: envelope.resources,
        ttlMs: this.config.limits.draftTtlMs,
      });
      this.store.completeMessage(message.messageId, reply);

      await this.channel.send(message.chatId, { markdown: reply }, { replyTo: message.messageId });
      logger.info("message.completed", {
        messageId: message.messageId,
        diagnosticsCount: result.diagnostics.length,
        draftAction: result.draft.action,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.store.failMessage(message.messageId, reason);
      logger.error("message.failed", { messageId: message.messageId, error: reason });
      try {
        const reply =
          error instanceof VisitRecordError
            ? [
                "没有创建工单：飞书妙记尚未能被服务读取。",
                reason,
                "请确认妙记已生成完成、已共享给当前飞书账号，并由管理员补齐妙记读取权限后，重新发送同一妙记链接。",
              ].join("\n")
            : errorMessage(message.messageId);
        await this.channel.send(
          message.chatId,
          { markdown: reply },
          { replyTo: message.messageId },
        );
      } catch (replyError) {
        logger.error("message.failure_reply_failed", {
          messageId: message.messageId,
          error: replyError instanceof Error ? replyError.message : String(replyError),
        });
      }
    }
  }

  private async downloadResources(message: NormalizedMessage): Promise<DownloadedResource[]> {
    const directory = join(this.config.storage.resourceDir, message.messageId);
    await mkdir(directory, { recursive: true });

    return Promise.all(
      message.resources.map(async (resource, index): Promise<DownloadedResource> => {
        const base: DownloadedResource = {
          type: resource.type,
          fileKey: resource.fileKey,
          ...(resource.fileName ? { fileName: resource.fileName } : {}),
        };
        if (resource.type === "sticker") {
          return { ...base, error: "sticker resources are not archived" };
        }

        try {
          const kind = resource.type === "image" ? "image" : "file";
          // Inbound message resources must be downloaded through
          // messageResource.get. image.get/file.get only work for files that
          // the current bot uploaded itself and return HTTP 400 for user
          // attachments.
          const response = await this.channel.rawClient.im.v1.messageResource.get({
            params: { type: kind },
            path: {
              message_id: message.messageId,
              file_key: resource.fileKey,
            },
          });
          const buffer = await streamToBuffer(response.getReadableStream());
          if (buffer.byteLength > this.config.limits.maxResourceBytes) {
            return {
              ...base,
              size: buffer.byteLength,
              error: `resource exceeds ${this.config.limits.maxResourceBytes} byte limit`,
            };
          }
          const name = safeName(resource, index);
          const path = join(directory, `${String(index + 1).padStart(2, "0")}-${name}`);
          await writeFile(path, buffer, { flag: "wx" });
          return {
            ...base,
            fileName: name,
            localPath: path,
            size: buffer.byteLength,
            sha256: createHash("sha256").update(buffer).digest("hex"),
          };
        } catch (error) {
          return {
            ...base,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  private toEnvelope(
    message: NormalizedMessage,
    resources: DownloadedResource[],
    contentMaintenanceProducerSource?: ContentMaintenanceProducerSource,
    meegleIdentity?: MeegleRequestIdentity,
    visitRecord?: VisitRecordEvidence,
  ): InboundEnvelope {
    return {
      messageId: message.messageId,
      chatId: message.chatId,
      chatType: message.chatType,
      senderId: message.senderId,
      ...(message.senderName ? { senderName: message.senderName } : {}),
      content: message.content,
      rawContentType: message.rawContentType,
      ...(message.rootId ? { rootId: message.rootId } : {}),
      ...(message.threadId ? { threadId: message.threadId } : {}),
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      createTime: message.createTime,
      resources,
      routePolicy: visitRecord
        ? {
            mode: "customer_only",
            authoritative: true,
            customerIssueOption: "上门服务",
            reason: "trusted_visit_record_minutes_trigger",
          }
        : deriveIntakeRoutePolicy(message.content),
      ...(meegleIdentity ? { meegleIdentity } : {}),
      ...(visitRecord ? { visitRecord } : {}),
      ...(contentMaintenanceProducerSource
        ? { contentMaintenanceProducerSource }
        : {}),
    };
  }

  private async readVisitRecord(
    message: NormalizedMessage,
  ): Promise<VisitRecordEvidence> {
    if (!this.visitRecordLoader) {
      throw new VisitRecordError("上门服务妙记读取器未启用");
    }
    const links = extractMinuteLinks(messageEvidenceText(message));
    if (links.length !== 1) {
      throw new VisitRecordError(
        links.length
          ? "一条消息包含多个妙记链接；请每条消息只发送一个会议记录"
          : "消息中没有找到可读取的飞书妙记链接",
      );
    }
    let sourceChatName: string;
    try {
      const chat = await this.channel.getChatInfo(message.chatId);
      sourceChatName = chat.name?.trim() ?? "";
    } catch (error) {
      throw new VisitRecordError(
        `无法读取来源群名称：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!sourceChatName) {
      throw new VisitRecordError("来源群没有可读取的群名称，无法自动匹配客户");
    }
    return this.visitRecordLoader.load({
      messageId: message.messageId,
      sourceChatId: message.chatId,
      sourceChatName,
      link: links[0]!,
    });
  }

  private async readContentMaintenanceProducerSource(): Promise<
    ContentMaintenanceProducerSource | undefined
  > {
    const source = this.config.lark.contentMaintenanceProducerSource;
    if (!source) return undefined;

    const base = {
      chatId: source.chatId,
      producerNames: [] as string[],
      fetchedAt: Date.now(),
    };
    try {
      const chat = await this.channel.getChatInfo(source.chatId);
      const chatName = chat.name?.trim();
      if (!chatName) {
        return { ...base, error: "configured producer source chat has no readable name" };
      }
      return {
        ...base,
        chatName,
        producerNames: parseProducerNames(chatName, source),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn("content_maintenance.producer_source_failed", {
        chatId: source.chatId,
        error: reason,
      });
      return { ...base, error: reason };
    }
  }

  private transcriptText(envelope: InboundEnvelope): string {
    const attachmentSummary = envelope.resources
      .map((resource) =>
        resource.localPath
          ? `[附件 ${resource.fileName ?? resource.fileKey}]`
          : `[附件下载失败 ${resource.fileName ?? resource.fileKey}]`,
      )
      .join(" ");
    return [envelope.content, attachmentSummary].filter(Boolean).join("\n").trim();
  }
}
