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
  producerRoster?: string[];
  selectionMode?: "all" | "round_robin_single";
  fetchedAt: number;
  error?: string;
}

export interface MeegleRequestIdentity {
  profile: string;
  userKey: string;
  name: string;
  email?: string;
}

export interface VisitRecordChapter {
  title?: string;
  startMs?: string;
  stopMs?: string;
  summary?: string;
}

export interface VisitRecordTodo {
  content?: string;
  assignees?: string[];
  isDone?: boolean;
}

export interface VisitRecordEvidence {
  sourceChatId: string;
  sourceChatName: string;
  minuteToken: string;
  minuteUrl: string;
  title?: string;
  summary?: string;
  chapters: VisitRecordChapter[];
  todos: VisitRecordTodo[];
  keywords: string[];
  transcriptPath?: string;
  fetchedAt: number;
}

export type PairedWorkItemType =
  | "blocking_issue"
  | "content_maintenance"
  | "demand_pool"
  | "customer_card_machine"
  | "risk_control";

export interface IntakeRoutePolicy {
  mode: "customer_bundle" | "customer_only" | "customer_auto" | "standalone" | "unspecified";
  authoritative: boolean;
  reason: string;
  customerIssueOption?: string;
  pairedWorkItemType?: PairedWorkItemType;
  standaloneWorkItemType?: PairedWorkItemType;
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
  routePolicy?: IntakeRoutePolicy;
  contentMaintenanceProducerSource?: ContentMaintenanceProducerSource;
  visitRecord?: VisitRecordEvidence;
  meegleIdentity?: MeegleRequestIdentity;
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
  attachmentArchive: AttachmentArchiveReport;
  diagnostics: string[];
}

export type AttachmentArchiveStatus =
  | "not_applicable"
  | "pending"
  | "verified"
  | "failed";

export interface AttachmentArchiveTarget {
  workItemId: string;
  fieldKey: string;
  expectedFiles: number;
  verifiedFiles: number;
}

export interface AttachmentArchiveReport {
  status: AttachmentArchiveStatus;
  expectedBindings: number;
  verifiedBindings: number;
  targets: AttachmentArchiveTarget[];
  note?: string;
}

export interface AgentBackend {
  run(request: AgentRequest): Promise<AgentResult>;
}
