import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
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

interface MessageRow {
  status: MessageStatus;
  updated_at: number;
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
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
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
        UNIQUE(message_id, file_key)
      );
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
    const statement = this.db.prepare(`
      INSERT INTO message_resources (
        message_id, file_key, resource_type, file_name, local_path, sha256, size, error_text
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id, file_key) DO UPDATE SET
        resource_type = excluded.resource_type,
        file_name = excluded.file_name,
        local_path = excluded.local_path,
        sha256 = excluded.sha256,
        size = excluded.size,
        error_text = excluded.error_text
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
        );
      }
    })();
  }
}
