import { webhookRoute } from "@sarraf/next";
import { applyEvent, getPay } from "../../../../lib/pay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reads the exact body, verifies the signature, then applies the event (deduplicated on event.id).
// 404 unknown provider · 400 invalid signature · 500 if applyEvent throws, so the provider retries.
export const POST = webhookRoute(() => getPay().pay, applyEvent);
