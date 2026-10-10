import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type {
  DownloadedResource,
  DraftMemoryUpdate,
  DraftSnapshot,
  MessageRole,
  StoredMessage,
} from "./types.js";

type MessageStatus = "processing" | "completed" | "failed";
export type OperationStatus = "started" | "succeeded" | "failed" | "info";
export type OperationDetailValue = string | number | boolean | null | string[] | number[];
export type OperationDetail = Record<string, OperationDetailValue>;

export interface MessageOperation {
  id: number;
  messageId: string;
  step: string;
  status: OperationStatus;
  detail: OperationDetail;
  createdAt: number;
}

export interface StaleResourceRecord {
  id: number;
  messageId: string;
  localPath: string;
}

interface MessageRow {
  status: MessageStatus;
  updated_at: number;
}

export interface StoredMessageResult {
  status: MessageStatus;
  responseText?: string;
  errorText?: string;
}

interface DraftRow {
  id: string;
  conversation_key: string;
  chat_id: string;
  sender_id: string;
  ticket_type: string | null;
  summary: string;
  missing_fields_json: string;
  work_item_ids_json: string;
  resources_json: string;
  updated_at: number;
  expires_at: number;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseResources(value: string): DownloadedResource[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is DownloadedResource =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { fileKey?: unknown }).fileKey === "string" &&
        typeof (item as { type?: unknown }).type === "string",
    );
  } catch {
    return [];
  }
}

function mergeResources(
  existing: DownloadedResource[],
  incoming: DownloadedResource[],
): DownloadedResource[] {
  const merged = new Map(existing.map((resource) => [resource.fileKey, resource]));
  for (const resource of incoming) merged.set(resource.fileKey, resource);
  return [...merged.values()].slice(-50);
}

function draftSnapshot(row: DraftRow): DraftSnapshot {
  return {
    id: row.id,
    conversationKey: row.conversation_key,
    chatId: row.chat_id,
    senderId: row.sender_id,
    ...(row.ticket_type ? { ticketType: row.ticket_type } : {}),
    summary: row.summary,
    missingFields: parseStringArray(row.missing_fields_json),
    workItemIds: parseStringArray(row.work_item_ids_json),
    resources: parseResources(row.resources_json),
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

export class BridgeStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    chmodSync(path, 0o600);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${path}${suffix}`;
      if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inbound_messages (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
        response_text TEXT,
        error_text TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_key TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(conversation_key, role, source_message_id)
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_messages_recent
        ON conversation_messages(conversation_key, id DESC);

      CREATE TABLE IF NOT EXISTS ticket_drafts (
        id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('open', 'closed', 'expired')),
        ticket_type TEXT,
        summary TEXT NOT NULL,
        missing_fields_json TEXT NOT NULL,
        work_item_ids_json TEXT NOT NULL,
        resources_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ticket_drafts_active
        ON ticket_drafts(chat_id, sender_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS producer_rotations (
        source_chat_id TEXT PRIMARY KEY,
        roster_json TEXT NOT NULL,
        next_index INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS producer_assignments (
        conversation_key TEXT PRIMARY KEY,
        source_chat_id TEXT NOT NULL,
        roster_json TEXT NOT NULL,
        producer_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_producer_assignments_source
        ON producer_assignments(source_chat_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS message_resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        file_key TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        file_name TEXT,
        local_path TEXT,
        sha256 TEXT,
        size INTEGER,
        error_text TEXT,
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(message_id, file_key)
      );

      CREATE TABLE IF NOT EXISTS message_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        step TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('started', 'succeeded', 'failed', 'info')),
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_message_operations_message
        ON message_operations(message_id, id);
      CREATE INDEX IF NOT EXISTS idx_message_operations_created
        ON message_operations(created_at);
    `);

    const resourceColumns = this.db
      .prepare("PRAGMA table_info(message_resources)")
      .all() as Array<{ name: string }>;
    const names = new Set(resourceColumns.map((column) => column.name));
    if (!names.has("created_at")) {
      this.db.exec("ALTER TABLE message_resources ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0");
    }
    if (!names.has("updated_at")) {
      this.db.exec("ALTER TABLE message_resources ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_message_resources_updated
      ON message_resources(updated_at)`);
    this.db.exec(`
      UPDATE message_resources
      SET created_at = COALESCE(
            NULLIF(created_at, 0),
            (SELECT created_at FROM inbound_messages WHERE inbound_messages.message_id = message_resources.message_id),
            CAST(unixepoch('now') AS INTEGER) * 1000
          ),
          updated_at = COALESCE(
            NULLIF(updated_at, 0),
            (SELECT updated_at FROM inbound_messages WHERE inbound_messages.message_id = message_resources.message_id),
            CAST(unixepoch('now') AS INTEGER) * 1000
          )
      WHERE created_at = 0 OR updated_at = 0
    `);
  }

  claimMessage(input: {
    messageId: string;
    chatId: string;
    senderId: string;
    staleAfterMs?: number;
  }): boolean {
    const now = Date.now();
    const staleAfterMs = input.staleAfterMs ?? 10 * 60_000;

    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT status, updated_at FROM inbound_messages WHERE message_id = ?")
        .get(input.messageId) as MessageRow | undefined;

      if (existing?.status === "completed" || existing?.status === "failed") return false;
      if (existing?.status === "processing" && now - existing.updated_at < staleAfterMs) {
        return false;
      }

      this.db
        .prepare(`
          INSERT INTO inbound_messages (
            message_id, chat_id, sender_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'processing', ?, ?)
          ON CONFLICT(message_id) DO UPDATE SET
            status = 'processing',
            error_text = NULL,
            updated_at = excluded.updated_at
        `)
        .run(input.messageId, input.chatId, input.senderId, now, now);
      return true;
    })();
  }

  messageResult(messageId: string): StoredMessageResult | undefined {
    const row = this.db
      .prepare(
        `SELECT status, response_text, error_text
         FROM inbound_messages WHERE message_id = ?`,
      )
      .get(messageId) as
      | {
          status: MessageStatus;
          response_text: string | null;
          error_text: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      status: row.status,
      ...(row.response_text ? { responseText: row.response_text } : {}),
      ...(row.error_text ? { errorText: row.error_text } : {}),
    };
  }

  assignNextProducer(input: {
    sourceChatId: string;
    conversationKey: string;
    producerNames: string[];
    now?: number;
  }): string | undefined {
    const roster = [
      ...new Set(input.producerNames.map((name) => name.trim()).filter(Boolean)),
    ];
    if (!roster.length) return undefined;
    const rosterJson = JSON.stringify(roster);
    const now = input.now ?? Date.now();

    return this.db.transaction(() => {
      const existing = this.db
        .prepare(`
          SELECT producer_name, source_chat_id, roster_json
          FROM producer_assignments
          WHERE conversation_key = ?
        `)
        .get(input.conversationKey) as
        | { producer_name: string; source_chat_id: string; roster_json: string }
        | undefined;
      if (
        existing?.source_chat_id === input.sourceChatId &&
        roster.includes(existing.producer_name)
      ) {
        this.db
          .prepare(`
            UPDATE producer_assignments
            SET roster_json = ?, updated_at = ?
            WHERE conversation_key = ?
          `)
          .run(rosterJson, now, input.conversationKey);
        return existing.producer_name;
      }

      const rotation = this.db
        .prepare(`
          SELECT roster_json, next_index
          FROM producer_rotations
          WHERE source_chat_id = ?
        `)
        .get(input.sourceChatId) as { roster_json: string; next_index: number } | undefined;
      const index = rotation?.roster_json === rosterJson ? rotation.next_index % roster.length : 0;
      const selected = roster[index]!;
      const nextIndex = (index + 1) % roster.length;

      this.db
        .prepare(`
          INSERT INTO producer_rotations (source_chat_id, roster_json, next_index, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(source_chat_id) DO UPDATE SET
            roster_json = excluded.roster_json,
            next_index = excluded.next_index,
            updated_at = excluded.updated_at
        `)
        .run(input.sourceChatId, rosterJson, nextIndex, now);
      this.db
        .prepare(`
          INSERT INTO producer_assignments (
            conversation_key, source_chat_id, roster_json, producer_name, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_key) DO UPDATE SET
            source_chat_id = excluded.source_chat_id,
            roster_json = excluded.roster_json,
            producer_name = excluded.producer_name,
            updated_at = excluded.updated_at
        `)
        .run(input.conversationKey, input.sourceChatId, rosterJson, selected, now, now);

      return selected;
    })();
  }

  completeMessage(messageId: string, responseText: string): void {
    this.db
      .prepare(`
        UPDATE inbound_messages
        SET status = 'completed', response_text = ?, error_text = NULL, updated_at = ?
        WHERE message_id = ?
      `)
      .run(responseText, Date.now(), messageId);
  }

  failMessage(messageId: string, errorText: string): void {
    this.db
      .prepare(`
        UPDATE inbound_messages
        SET status = 'failed', error_text = ?, updated_at = ?
        WHERE message_id = ?
      `)
      .run(errorText.slice(0, 4_000), Date.now(), messageId);
  }

  recordOperation(input: {
    messageId: string;
    step: string;
    status: OperationStatus;
    detail?: OperationDetail;
    createdAt?: number;
  }): void {
    this.db
      .prepare(`
        INSERT INTO message_operations (message_id, step, status, detail_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        input.messageId,
        input.step.slice(0, 100),
        input.status,
        JSON.stringify(input.detail ?? {}),
        input.createdAt ?? Date.now(),
      );
  }

  messageOperations(messageId: string): MessageOperation[] {
    const rows = this.db
      .prepare(`
        SELECT id, message_id, step, status, detail_json, created_at
        FROM message_operations WHERE message_id = ? ORDER BY id
      `)
      .all(messageId) as Array<{
      id: number;
      message_id: string;
      step: string;
      status: OperationStatus;
      detail_json: string;
      created_at: number;
    }>;
    return rows.map((row) => {
      let detail: OperationDetail = {};
      try {
        detail = JSON.parse(row.detail_json) as OperationDetail;
      } catch {
        detail = {};
      }
      return {
        id: row.id,
        messageId: row.message_id,
        step: row.step,
        status: row.status,
        detail,
        createdAt: row.created_at,
      };
    });
  }

  messageAudit(messageId: string): unknown {
    const message = this.db
      .prepare(`
        SELECT message_id, chat_id, sender_id, status, error_text, created_at, updated_at
        FROM inbound_messages WHERE message_id = ?
      `)
      .get(messageId);
    const resources = this.db
      .prepare(`
        SELECT id, file_key, resource_type, file_name, local_path, sha256, size,
               error_text, created_at, updated_at
        FROM message_resources WHERE message_id = ? ORDER BY id
      `)
      .all(messageId);
    return { message, operations: this.messageOperations(messageId), resources };
  }

  operationalSummary(limit = 20): unknown {
    const counts = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM inbound_messages GROUP BY status")
      .all();
    const openDrafts = this.db
      .prepare("SELECT COUNT(*) AS count FROM ticket_drafts WHERE status = 'open'")
      .get();
    const failed = this.db
      .prepare(`
        SELECT message_id, chat_id, sender_id, error_text, updated_at
        FROM inbound_messages WHERE status = 'failed'
        ORDER BY updated_at DESC LIMIT ?
      `)
      .all(limit);
    return { counts, openDrafts, recentFailed: failed };
  }

  addConversationMessage(input: {
    conversationKey: string;
    role: MessageRole;
    content: string;
    sourceMessageId: string;
    createdAt?: number;
  }): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO conversation_messages (
          conversation_key, role, content, source_message_id, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        input.conversationKey,
        input.role,
        input.content,
        input.sourceMessageId,
        input.createdAt ?? Date.now(),
      );
  }

  recentConversation(
    conversationKey: string,
    limit: number,
    newerThan = 0,
  ): StoredMessage[] {
    const rows = this.db
      .prepare(`
        SELECT role, content, source_message_id, created_at
        FROM conversation_messages
        WHERE conversation_key = ? AND created_at >= ?
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(conversationKey, newerThan, limit) as Array<{
      role: MessageRole;
      content: string;
      source_message_id: string;
      created_at: number;
    }>;

    return rows.reverse().map((row) => ({
      role: row.role,
      content: row.content,
      sourceMessageId: row.source_message_id,
      createdAt: row.created_at,
    }));
  }

  activeDraft(input: {
    conversationKey: string;
    chatId: string;
    senderId: string;
    referenceMessageIds?: string[];
    allowParticipantFallback?: boolean;
    now?: number;
  }): DraftSnapshot | undefined {
    const now = input.now ?? Date.now();
    this.db
      .prepare(`UPDATE ticket_drafts SET status = 'expired' WHERE status = 'open' AND expires_at <= ?`)
      .run(now);

    const exact = this.db
      .prepare(`
        SELECT id, conversation_key, chat_id, sender_id, ticket_type, summary,
               missing_fields_json, work_item_ids_json, resources_json, updated_at, expires_at
        FROM ticket_drafts
        WHERE conversation_key = ? AND chat_id = ? AND sender_id = ? AND status = 'open'
        LIMIT 1
      `)
      .get(input.conversationKey, input.chatId, input.senderId) as DraftRow | undefined;
    if (exact) return draftSnapshot(exact);

    const referenceMessageIds = [
      ...new Set(
        (input.referenceMessageIds ?? [])
          .map((messageId) => messageId.trim())
          .filter(Boolean),
      ),
    ];
    if (referenceMessageIds.length > 0) {
      const placeholders = referenceMessageIds.map(() => "?").join(", ");
      const referenced = this.db
        .prepare(`
          SELECT DISTINCT
                 draft.id, draft.conversation_key, draft.chat_id, draft.sender_id,
                 draft.ticket_type, draft.summary, draft.missing_fields_json,
                 draft.work_item_ids_json, draft.resources_json, draft.updated_at,
                 draft.expires_at
          FROM conversation_messages AS message
          JOIN ticket_drafts AS draft
            ON draft.conversation_key = message.conversation_key
          WHERE message.source_message_id IN (${placeholders})
            AND draft.chat_id = ?
            AND draft.sender_id = ?
            AND draft.status = 'open'
          ORDER BY draft.updated_at DESC
          LIMIT 2
        `)
        .all(...referenceMessageIds, input.chatId, input.senderId) as DraftRow[];
      if (referenced.length === 1) return draftSnapshot(referenced[0]!);
    }

    // A threaded/reply message must never attach to a different draft. The
    // caller only enables participant fallback for an unscoped message, where
    // it is still safe solely when that participant has exactly one open draft.
    if (!input.allowParticipantFallback) return undefined;

    const candidates = this.db
      .prepare(`
        SELECT id, conversation_key, chat_id, sender_id, ticket_type, summary,
               missing_fields_json, work_item_ids_json, resources_json, updated_at, expires_at
        FROM ticket_drafts
        WHERE chat_id = ? AND sender_id = ? AND status = 'open'
        ORDER BY updated_at DESC
        LIMIT 2
      `)
      .all(input.chatId, input.senderId) as DraftRow[];
    return candidates.length === 1 ? draftSnapshot(candidates[0]!) : undefined;
  }

  applyDraftUpdate(input: {
    conversationKey: string;
    chatId: string;
    senderId: string;
    activeDraftId?: string;
    update: DraftMemoryUpdate;
    resources?: DownloadedResource[];
    ttlMs: number;
    now?: number;
  }): DraftSnapshot | undefined {
    const now = input.now ?? Date.now();
    const expiresAt = now + input.ttlMs;
    const ticketType = input.update.ticketType?.trim().slice(0, 200) || null;
    const summary = input.update.summary?.trim().slice(0, 4_000) || "";
    const missingFields = input.update.missingFields
      .map((item) => item.trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 50);
    const workItemIds = input.update.workItemIds
      .map((item) => item.trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 50);
    const incomingResources = input.resources ?? [];

    return this.db.transaction(() => {
      this.db
        .prepare(`UPDATE ticket_drafts SET status = 'expired' WHERE status = 'open' AND expires_at <= ?`)
        .run(now);

      if (input.update.action === "none") return undefined;

      if (input.update.action === "close") {
        const targetId = input.activeDraftId ?? (
          this.db
            .prepare(`
              SELECT id FROM ticket_drafts
              WHERE conversation_key = ? AND chat_id = ? AND sender_id = ? AND status = 'open'
              LIMIT 1
            `)
            .get(input.conversationKey, input.chatId, input.senderId) as { id: string } | undefined
        )?.id;
        if (!targetId) return undefined;
        this.db
          .prepare(`
            UPDATE ticket_drafts
            SET status = 'closed',
                ticket_type = COALESCE(?, ticket_type),
                summary = CASE WHEN ? = '' THEN summary ELSE ? END,
                missing_fields_json = ?, work_item_ids_json = ?, updated_at = ?
            WHERE id = ? AND chat_id = ? AND sender_id = ?
          `)
          .run(
            ticketType,
            summary,
            summary,
            JSON.stringify(missingFields),
            JSON.stringify(workItemIds),
            now,
            targetId,
            input.chatId,
            input.senderId,
          );
        return undefined;
      }

      if (input.update.action === "update" && input.activeDraftId) {
        const current = this.db
          .prepare(`SELECT resources_json FROM ticket_drafts WHERE id = ?`)
          .get(input.activeDraftId) as { resources_json: string } | undefined;
        const resources = mergeResources(
          current ? parseResources(current.resources_json) : [],
          incomingResources,
        );
        this.db
          .prepare(`
            UPDATE ticket_drafts
            SET ticket_type = COALESCE(?, ticket_type), summary = ?,
                missing_fields_json = ?, work_item_ids_json = ?, resources_json = ?,
                updated_at = ?, expires_at = ?
            WHERE id = ? AND chat_id = ? AND sender_id = ? AND status = 'open'
          `)
          .run(
            ticketType,
            summary,
            JSON.stringify(missingFields),
            JSON.stringify(workItemIds),
            JSON.stringify(resources),
            now,
            expiresAt,
            input.activeDraftId,
            input.chatId,
            input.senderId,
          );
        const updated = this.db
          .prepare(`
            SELECT id, conversation_key, chat_id, sender_id, ticket_type, summary,
                   missing_fields_json, work_item_ids_json, resources_json, updated_at, expires_at
            FROM ticket_drafts WHERE id = ? AND status = 'open'
          `)
          .get(input.activeDraftId) as DraftRow | undefined;
        if (updated) return draftSnapshot(updated);
      }

      const id = randomUUID();
      this.db
        .prepare(`
          INSERT INTO ticket_drafts (
            id, conversation_key, chat_id, sender_id, status, ticket_type, summary,
            missing_fields_json, work_item_ids_json, resources_json, created_at, updated_at, expires_at
          ) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_key) DO UPDATE SET
            chat_id = excluded.chat_id,
            sender_id = excluded.sender_id,
            status = 'open',
            ticket_type = excluded.ticket_type,
            summary = excluded.summary,
            missing_fields_json = excluded.missing_fields_json,
            work_item_ids_json = excluded.work_item_ids_json,
            resources_json = excluded.resources_json,
            updated_at = excluded.updated_at,
            expires_at = excluded.expires_at
        `)
        .run(
          id,
          input.conversationKey,
          input.chatId,
          input.senderId,
          ticketType,
          summary,
          JSON.stringify(missingFields),
          JSON.stringify(workItemIds),
          JSON.stringify(incomingResources.slice(-50)),
          now,
          now,
          expiresAt,
        );
      const row = this.db
        .prepare(`
          SELECT id, conversation_key, chat_id, sender_id, ticket_type, summary,
                 missing_fields_json, work_item_ids_json, resources_json, updated_at, expires_at
          FROM ticket_drafts WHERE conversation_key = ? AND status = 'open'
        `)
        .get(input.conversationKey) as DraftRow;
      return draftSnapshot(row);
    })();
  }

  saveResources(messageId: string, resources: DownloadedResource[]): void {
    const now = Date.now();
    const statement = this.db.prepare(`
      INSERT INTO message_resources (
        message_id, file_key, resource_type, file_name, local_path, sha256, size,
        error_text, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id, file_key) DO UPDATE SET
        resource_type = excluded.resource_type,
        file_name = excluded.file_name,
        local_path = excluded.local_path,
        sha256 = excluded.sha256,
        size = excluded.size,
        error_text = excluded.error_text,
        updated_at = excluded.updated_at
    `);

    this.db.transaction(() => {
      for (const resource of resources) {
        statement.run(
          messageId,
          resource.fileKey,
          resource.type,
          resource.fileName ?? null,
          resource.localPath ?? null,
          resource.sha256 ?? null,
          resource.size ?? null,
          resource.error ?? null,
          now,
          now,
        );
      }
    })();
  }

  expireDrafts(now = Date.now()): number {
    return this.db
      .prepare(`UPDATE ticket_drafts SET status = 'expired', updated_at = ?
        WHERE status = 'open' AND expires_at <= ?`)
      .run(now, now).changes;
  }

  staleResourceRecords(cutoff: number): StaleResourceRecord[] {
    const protectedPaths = new Set<string>();
    const openDrafts = this.db
      .prepare("SELECT resources_json FROM ticket_drafts WHERE status = 'open'")
      .all() as Array<{ resources_json: string }>;
    for (const draft of openDrafts) {
      for (const resource of parseResources(draft.resources_json)) {
        if (resource.localPath) protectedPaths.add(resource.localPath);
      }
    }
    const rows = this.db
      .prepare(`
        SELECT id, message_id, local_path FROM message_resources
        WHERE updated_at < ? AND local_path IS NOT NULL
      `)
      .all(cutoff) as Array<{ id: number; message_id: string; local_path: string }>;
    return rows
      .filter((row) => !protectedPaths.has(row.local_path))
      .map((row) => ({ id: row.id, messageId: row.message_id, localPath: row.local_path }));
  }

  deleteResourceRecord(id: number): void {
    this.db.prepare("DELETE FROM message_resources WHERE id = ?").run(id);
  }

  pruneAudit(cutoff: number): {
    operations: number;
    conversations: number;
    drafts: number;
    inbound: number;
    resourceErrors: number;
  } {
    return this.db.transaction(() => {
      const operations = this.db
        .prepare("DELETE FROM message_operations WHERE created_at < ?")
        .run(cutoff).changes;
      const conversations = this.db
        .prepare(`
          DELETE FROM conversation_messages
          WHERE created_at < ? AND conversation_key NOT IN (
            SELECT conversation_key FROM ticket_drafts WHERE status = 'open'
          )
        `)
        .run(cutoff).changes;
      const drafts = this.db
        .prepare("DELETE FROM ticket_drafts WHERE status != 'open' AND updated_at < ?")
        .run(cutoff).changes;
      const resourceErrors = this.db
        .prepare(`DELETE FROM message_resources
          WHERE updated_at < ? AND local_path IS NULL`)
        .run(cutoff).changes;
      const inbound = this.db
        .prepare(`DELETE FROM inbound_messages
          WHERE status != 'processing' AND updated_at < ?
            AND message_id NOT IN (SELECT message_id FROM message_resources)`)
        .run(cutoff).changes;
      return { operations, conversations, drafts, inbound, resourceErrors };
    })();
  }
}
