export type MessageRole = "user" | "assistant";

export interface StoredMessage {
  role: MessageRole;
  content: string;
  sourceMessageId: string;
  createdAt: number;
}

export type DraftAction = "none" | "open" | "update" | "close";

export interface DraftMemoryUpdate {
  action: DraftAction;
  ticketType?: string;
  summary?: string;
  missingFields: string[];
  workItemIds: string[];
}

export interface DraftSnapshot {
  id: string;
  conversationKey: string;
  chatId: string;
  senderId: string;
  ticketType?: string;
  summary: string;
  missingFields: string[];
  workItemIds: string[];
  resources: DownloadedResource[];
  updatedAt: number;
  expiresAt: number;
}

export interface DownloadedResource {
  type: "image" | "file" | "audio" | "video" | "sticker";
  fileKey: string;
  fileName?: string;
  localPath?: string;
  sha256?: string;
  size?: number;
  error?: string;
}

export interface ContentMaintenanceProducerSource {
  chatId: string;
  chatName?: string;
  producerNames: string[];
  fetchedAt: number;
  error?: string;
}

export interface InboundEnvelope {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  senderId: string;
  senderName?: string;
  content: string;
  rawContentType: string;
  rootId?: string;
  threadId?: string;
  replyToMessageId?: string;
  createTime: number;
  resources: DownloadedResource[];
  contentMaintenanceProducerSource?: ContentMaintenanceProducerSource;
}

export interface AgentRequest {
  envelope: InboundEnvelope;
  history: StoredMessage[];
  activeDraft?: DraftSnapshot;
  resourceRoot: string;
}

export interface AgentResult {
  text: string;
  draft: DraftMemoryUpdate;
  diagnostics: string[];
}

export interface AgentBackend {
  run(request: AgentRequest): Promise<AgentResult>;
}
