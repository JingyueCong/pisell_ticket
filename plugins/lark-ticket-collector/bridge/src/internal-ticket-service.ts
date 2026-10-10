import type { BridgeConfig } from "./config.js";
import { KeyedQueue } from "./keyed-queue.js";
import { logger } from "./logger.js";
import { MeegleIdentityManager } from "./meegle-identity.js";
import { conversationKey } from "./prompt.js";
import { BridgeStore } from "./store.js";
import type {
  AgentBackend,
  InboundEnvelope,
  InternalCustomerTicketRequest,
  InternalCustomerTicketResponse,
  MeegleRequestIdentity,
} from "./types.js";
import { customerIntakeOwnerTarget } from "./work-item-outcomes.js";

function requestText(input: InternalCustomerTicketRequest): string {
  const context = input.context
    .slice(-12)
    .map((item) => `${item.role === "user" ? "用户" : "客户信息机器人"}：${item.content}`)
    .join("\n");
  return [
    "请根据以下未解决的客户问题创建客服工单。只创建客服主单，不创建、复用或关联任何 T1/T2/T3/T5、阻断性问题、内容维护、需求或其他配套工作项。",
    input.merchantName ? `商户：${input.merchantName}` : undefined,
    input.senderName ? `问题提出人：${input.senderName}` : undefined,
    `原始问题：${input.content}`,
    context ? `客户信息 Agent 最近对话：\n${context}` : undefined,
    `原始飞书来源：chat=${input.sourceChatId} message=${input.sourceMessageId}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export class InternalTicketService {
  private readonly queue = new KeyedQueue();

  constructor(
    private readonly config: BridgeConfig,
    private readonly store: BridgeStore,
    private readonly agent: AgentBackend,
    private readonly identityManager?: MeegleIdentityManager,
  ) {}

  process(input: InternalCustomerTicketRequest): Promise<InternalCustomerTicketResponse> {
    const submitterSenderId = this.config.internalApi.submitterSenderId;
    if (!this.config.internalApi.enabled || !submitterSenderId) {
      throw new Error("internal customer-service ticket intake is disabled");
    }
    return this.queue.enqueue(submitterSenderId, () =>
      this.processSerialized(input, submitterSenderId),
    );
  }

  private async processSerialized(
    input: InternalCustomerTicketRequest,
    submitterSenderId: string,
  ): Promise<InternalCustomerTicketResponse> {
    const messageId = `merchant-profile:${input.requestId}`;
    const chatId = `merchant-profile:${input.conversationId}`;
    const existing = this.store.messageResult(messageId);
    if (existing?.status === "completed" && existing.responseText) {
      const activeDraft = this.activeDraft(chatId, submitterSenderId, input.conversationId);
      return {
        reply: existing.responseText,
        draftOpen: Boolean(activeDraft),
        workItemIds: activeDraft?.workItemIds ?? [],
        cached: true,
      };
    }
    if (existing?.status === "failed") {
      throw new Error(
        `this source message previously failed and was not replayed: ${existing.errorText ?? "unknown error"}`,
      );
    }

    const claimed = this.store.claimMessage({
      messageId,
      chatId,
      senderId: submitterSenderId,
    });
    if (!claimed) {
      throw new Error("this source message is already being processed");
    }
    this.store.recordOperation({
      messageId,
      step: "internal_message_claimed",
      status: "succeeded",
      detail: { source: "merchant_profile_agent" },
    });

    try {
      const meegleIdentity = await this.authorize(
        submitterSenderId,
        this.config.internalApi.submitterName,
        input.content,
      );
      const envelope: InboundEnvelope = {
        messageId,
        chatId,
        chatType: "p2p",
        senderId: submitterSenderId,
        ...(this.config.internalApi.submitterName
          ? { senderName: this.config.internalApi.submitterName }
          : {}),
        content: requestText(input),
        rawContentType: "internal_customer_service_handoff",
        threadId: input.conversationId,
        createTime: Date.now(),
        resources: [],
        routePolicy: {
          mode: "customer_only",
          authoritative: true,
          reason: "trusted_merchant_profile_unanswered_support_handoff",
        },
        ...(meegleIdentity ? { meegleIdentity } : {}),
      };
      const messageKey = conversationKey(envelope);
      const activeDraft = this.activeDraft(chatId, submitterSenderId, input.conversationId);
      const history = this.store.recentConversation(
        activeDraft?.conversationKey ?? messageKey,
        this.config.limits.maxHistoryMessages,
        Date.now() - this.config.limits.maxHistoryAgeMs,
      );
      this.store.recordOperation({
        messageId,
        step: "internal_agent_execution",
        status: "started",
      });
      const result = await this.agent.run({
        envelope,
        history,
        ...(activeDraft ? { activeDraft } : {}),
        resourceRoot: this.config.storage.resourceDir,
      });

      const nonCustomerOutcome = result.workItemOutcomes.find(
        (outcome) => outcome.role !== "customer",
      );
      if (nonCustomerOutcome) {
        throw new Error(
          `customer-only intake returned forbidden ${nonCustomerOutcome.role} outcome`,
        );
      }

      let reply = result.text;
      const customerWorkItemId = customerIntakeOwnerTarget(
        result,
        activeDraft?.workItemIds ?? [],
      );
      if (customerWorkItemId && meegleIdentity && this.identityManager) {
        try {
          await this.identityManager.ensureCustomerIntakeNodeOwner({
            identity: meegleIdentity,
            workItemId: customerWorkItemId,
          });
        } catch (error) {
          reply = [
            reply,
            "",
            `注意：客服工单 #${customerWorkItemId} 已保留，但“创建工单”节点负责人未能回读确认；请勿重复建单。`,
          ].join("\n");
          logger.warn("internal.customer_owner_failed", {
            messageId,
            workItemId: customerWorkItemId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const resultKey =
        result.draft.action === "update" || result.draft.action === "close"
          ? activeDraft?.conversationKey ?? messageKey
          : messageKey;
      this.store.addConversationMessage({
        conversationKey: resultKey,
        role: "user",
        content: envelope.content,
        sourceMessageId: messageId,
        createdAt: envelope.createTime,
      });
      this.store.addConversationMessage({
        conversationKey: resultKey,
        role: "assistant",
        content: reply,
        sourceMessageId: `response:${messageId}`,
      });
      const storedDraft = this.store.applyDraftUpdate({
        conversationKey: resultKey,
        chatId,
        senderId: submitterSenderId,
        ...(activeDraft ? { activeDraftId: activeDraft.id } : {}),
        update: result.draft,
        resources: [],
        ttlMs: this.config.limits.draftTtlMs,
      });
      this.store.completeMessage(messageId, reply);
      this.store.recordOperation({
        messageId,
        step: "internal_agent_execution",
        status: "succeeded",
        detail: {
          draftAction: result.draft.action,
          workItemIds: result.draft.workItemIds,
        },
      });
      return {
        reply,
        draftOpen: Boolean(storedDraft),
        workItemIds: result.draft.workItemIds,
        cached: false,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.store.failMessage(messageId, reason);
      this.store.recordOperation({
        messageId,
        step: "internal_agent_execution",
        status: "failed",
        detail: { error: reason.slice(0, 1_000) },
      });
      logger.error("internal.message_failed", { messageId, error: reason });
      throw error;
    }
  }

  private activeDraft(chatId: string, senderId: string, conversationId: string) {
    const key = conversationKey({
      chatId,
      senderId,
      messageId: conversationId,
      threadId: conversationId,
    });
    return this.store.activeDraft({
      conversationKey: key,
      chatId,
      senderId,
      allowParticipantFallback: false,
    });
  }

  private async authorize(
    senderId: string,
    senderName: string | undefined,
    messageText: string,
  ): Promise<MeegleRequestIdentity | undefined> {
    if (!this.identityManager) return undefined;
    const gate = await this.identityManager.authorize({
      senderId,
      ...(senderName ? { senderName } : {}),
      messageText,
    });
    if (gate.kind === "blocked") {
      throw new Error(`internal submitter identity is not authorized: ${gate.reply}`);
    }
    return gate.identity;
  }
}
