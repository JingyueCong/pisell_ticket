import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import { z } from "zod";

import { logger } from "./logger.js";
import type { InternalTicketService } from "./internal-ticket-service.js";
import type { InternalCustomerTicketRequest } from "./types.js";

const contextMessage = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(8_000),
  })
  .strict();

const requestSchema = z
  .object({
    request_id: z.string().trim().min(1).max(300),
    conversation_id: z.string().trim().min(1).max(300),
    source_chat_id: z.string().trim().min(1).max(300),
    source_message_id: z.string().trim().min(1).max(300),
    sender_name: z.string().trim().min(1).max(200).optional(),
    merchant_name: z.string().trim().min(1).max(300).optional(),
    content: z.string().trim().min(1).max(12_000),
    context: z.array(contextMessage).max(20).default([]),
  })
  .strict();

export function parseInternalCustomerTicketRequest(
  value: unknown,
): InternalCustomerTicketRequest {
  const parsed = requestSchema.parse(value);
  return {
    requestId: parsed.request_id,
    conversationId: parsed.conversation_id,
    sourceChatId: parsed.source_chat_id,
    sourceMessageId: parsed.source_message_id,
    ...(parsed.sender_name ? { senderName: parsed.sender_name } : {}),
    ...(parsed.merchant_name ? { merchantName: parsed.merchant_name } : {}),
    content: parsed.content,
    context: parsed.context,
  };
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const header = request.headers.authorization ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(expectedToken);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage, maxBytes = 65_536): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request_body_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createBridgeHttpHandler(input: {
  status: () => { ready: boolean; reason?: string };
  internalTicketService?: InternalTicketService;
  internalToken?: string;
}): RequestListener {
  return (request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && path === "/healthz") {
        const status = input.status();
        sendJson(response, status.ready ? 200 : 503, {
          ok: status.ready,
          ...(!status.ready && status.reason ? { reason: status.reason } : {}),
          internal_customer_service_api: Boolean(
            input.internalTicketService && input.internalToken,
          ),
        });
        return;
      }
      if (request.method !== "POST" || path !== "/internal/customer-service-tickets") {
        sendJson(response, 404, { ok: false, error: "not_found" });
        return;
      }
      if (!input.internalTicketService || !input.internalToken) {
        sendJson(response, 404, { ok: false, error: "not_found" });
        return;
      }
      if (!authorized(request, input.internalToken)) {
        sendJson(response, 401, { ok: false, error: "unauthorized" });
        return;
      }
      const status = input.status();
      if (!status.ready) {
        sendJson(response, 503, {
          ok: false,
          error: "service_not_ready",
          ...(status.reason ? { reason: status.reason } : {}),
        });
        return;
      }
      try {
        const ticketRequest = parseInternalCustomerTicketRequest(await readJson(request));
        const result = await input.internalTicketService.process(ticketRequest);
        sendJson(response, 200, {
          ok: true,
          reply: result.reply,
          draft_open: result.draftOpen,
          work_item_ids: result.workItemIds,
          cached: result.cached,
        });
      } catch (error) {
        if (error instanceof z.ZodError || (error instanceof SyntaxError)) {
          sendJson(response, 400, { ok: false, error: "invalid_request" });
          return;
        }
        if (error instanceof Error && error.message === "request_body_too_large") {
          sendJson(response, 413, { ok: false, error: "request_body_too_large" });
          return;
        }
        logger.error("internal.api_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        sendJson(response, 500, { ok: false, error: "ticket_agent_failed" });
      }
    })().catch((error: unknown) => {
      logger.error("internal.http_unhandled", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) {
        sendJson(response, 500, { ok: false, error: "internal_error" });
      } else {
        response.end();
      }
    });
  };
}
