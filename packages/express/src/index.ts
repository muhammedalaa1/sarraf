import type { IncomingMessage, ServerResponse } from "node:http";
import {
  defaultLogger,
  isSarrafError,
  type Logger,
  type ProviderId,
  type Sarraf,
  type SarrafEvent,
} from "@sarraf/core";

/** Minimal Express-compatible request/response types, so express stays an optional peer. */
export interface RawBodyRequest extends IncomingMessage {
  rawBody?: Buffer | undefined;
  body?: unknown;
  params?: Record<string, string> | undefined;
  query?: Record<string, unknown> | undefined;
}

type Next = (err?: unknown) => void;

export interface RawBodyOptions {
  /** Maximum body size in bytes. Default 1 MiB. */
  limit?: number | undefined;
  /** Parse JSON into `req.body` too. Default true. */
  json?: boolean | undefined;
}

/**
 * Keep the exact request bytes on `req.rawBody` (signatures are computed over them) and parse
 * JSON into `req.body`. Mount it on webhook routes *instead of* `express.json()`.
 */
export function rawBody(options: RawBodyOptions = {}) {
  const limit = options.limit ?? 1024 * 1024;
  const parseJson = options.json ?? true;
  return (req: RawBodyRequest, res: ServerResponse, next: Next): void => {
    if (req.rawBody) {
      next();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        res.statusCode = 413;
        res.end("Payload too large");
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      req.rawBody = Buffer.concat(chunks);
      if (parseJson && req.rawBody.length > 0 && /json/i.test(String(req.headers["content-type"] ?? ""))) {
        try {
          req.body = JSON.parse(req.rawBody.toString("utf8"));
        } catch {
          req.body = undefined;
        }
      }
      next();
    });
    req.on("error", (err) => {
      if (done) return;
      done = true;
      next(err);
    });
  };
}

export interface WebhookHandlerOptions {
  /** Route param holding the provider id. Default "provider". Ignored when `provider` is set. */
  param?: string | undefined;
  /** Fixed provider for this route. */
  provider?: ProviderId | undefined;
  /**
   * "handle-first" (default): run `onEvent`, then answer 200; a thrown error answers 500 so the
   * provider retries. "ack-first": answer 200 immediately, then run `onEvent` (enqueue only!).
   */
  mode?: "handle-first" | "ack-first" | undefined;
  logger?: Logger | undefined;
}

/**
 * Express handler that verifies, normalizes and dispatches provider webhooks.
 *
 * ```ts
 * app.post("/api/webhooks/:provider", rawBody(), webhookHandler(pay, async (event) => {
 *   await queue.add("payment-event", event, { jobId: event.id }); // dedupe on event.id
 * }));
 * ```
 */
export function webhookHandler(
  pay: Sarraf,
  onEvent: (event: SarrafEvent) => unknown,
  options: WebhookHandlerOptions = {},
) {
  const logger = options.logger ?? defaultLogger;
  const mode = options.mode ?? "handle-first";
  return async (req: RawBodyRequest, res: ServerResponse): Promise<void> => {
    const provider = (options.provider ?? req.params?.[options.param ?? "provider"]) as
      | ProviderId
      | undefined;
    if (!provider || !pay.providerIds.includes(provider)) {
      return send(res, 404, { error: "UNKNOWN_PROVIDER" });
    }
    if (!req.rawBody) {
      logger.error(
        "webhookHandler: req.rawBody is missing. Mount rawBody() on this route instead of express.json().",
      );
      return send(res, 500, { error: "RAW_BODY_MISSING" });
    }
    let event: SarrafEvent;
    try {
      event = await pay.webhooks.verifyAndParse(provider, {
        headers: req.headers,
        rawBody: req.rawBody,
        query: (req.query ?? queryOf(req.url)) as Record<string, string>,
      });
    } catch (err) {
      if (isSarrafError(err, "WEBHOOK_SIGNATURE_INVALID")) {
        logger.warn(`rejected ${provider} webhook`, { reason: err.message });
        return send(res, 400, { error: "WEBHOOK_SIGNATURE_INVALID" });
      }
      logger.error(`failed to process ${provider} webhook`, { error: String(err) });
      return send(res, 500, { error: "WEBHOOK_PROCESSING_FAILED" });
    }
    if (mode === "ack-first") {
      send(res, 200, { received: true, id: event.id });
      try {
        await onEvent(event);
      } catch (err) {
        logger.error(`onEvent failed after ack for ${event.id}`, { error: String(err) });
      }
      return;
    }
    try {
      await onEvent(event);
    } catch (err) {
      logger.error(`onEvent failed for ${event.id}; answering 500 so the provider retries`, {
        error: String(err),
      });
      return send(res, 500, { error: "HANDLER_FAILED" });
    }
    send(res, 200, { received: true, id: event.id });
  };
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function queryOf(url: string | undefined): Record<string, string> {
  return Object.fromEntries(new URL(url ?? "/", "http://localhost").searchParams);
}
