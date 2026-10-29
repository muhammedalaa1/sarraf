import type { ProviderId, RawWebhookRequest, Sarraf } from "@sarrafjs/core";
import type { Inbox, InboxEntry } from "./inbox";

/** Inspect, verify and parse a webhook, and store everything in the inbox, valid or not. */
export async function captureWebhook(
  pay: Sarraf,
  box: Inbox,
  provider: ProviderId,
  req: { headers: Record<string, string>; query: Record<string, string>; rawBody: string },
): Promise<InboxEntry> {
  const raw: RawWebhookRequest = { headers: req.headers, query: req.query, rawBody: req.rawBody };
  const inspection = await pay.webhooks.inspect(provider, raw);
  let event: InboxEntry["event"];
  let error: string | undefined;
  if (inspection.valid) {
    try {
      event = await pay.webhooks.verifyAndParse(provider, raw);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return box.add({
    provider,
    headers: req.headers,
    query: req.query,
    rawBody: req.rawBody,
    inspection,
    event,
    error,
  });
}

/** Re-run verification and parsing on a stored webhook (e.g. after fixing a secret). */
export async function replayWebhook(pay: Sarraf, box: Inbox, id: string): Promise<InboxEntry | undefined> {
  const entry = box.get(id);
  if (!entry) return undefined;
  const raw: RawWebhookRequest = { headers: entry.headers, query: entry.query, rawBody: entry.rawBody };
  const inspection = await pay.webhooks.inspect(entry.provider, raw);
  let event: InboxEntry["event"];
  let error: string | undefined;
  if (inspection.valid) {
    try {
      event = await pay.webhooks.verifyAndParse(entry.provider, raw);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  return box.update(id, { inspection, event, error, replays: entry.replays + 1 });
}
