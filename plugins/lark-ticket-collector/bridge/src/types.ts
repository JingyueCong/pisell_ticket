export type MessageRole = "user" | "assistant";

export interface StoredMessage {
  role: MessageRole;
  content: string;
  sourceMessageId: string;
  createdAt: number;
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
  resourceRoot: string;
}

export interface AgentResult {
  text: string;
  diagnostics: string[];
}

export interface AgentBackend {
  run(request: AgentRequest): Promise<AgentResult>;
}
