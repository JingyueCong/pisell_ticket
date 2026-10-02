import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type { DownloadedResource, MessageRole, StoredMessage } from "./types.js";

type MessageStatus = "processing" | "completed" | "failed";

interface MessageRow {
  status: MessageStatus;
  updated_at: number;
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

  recentConversation(conversationKey: string, limit: number): StoredMessage[] {
    const rows = this.db
      .prepare(`
        SELECT role, content, source_message_id, created_at
        FROM conversation_messages
        WHERE conversation_key = ?
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(conversationKey, limit) as Array<{
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
