import type { PaymentStatus } from "@sarraf/core";
import { statusTone } from "../lib/shop";

export function StatusBadge({ status }: { status: PaymentStatus }) {
  return <span className={`badge ${statusTone(status)}`}>{status.replace("_", " ")}</span>;
}

export function Notice({ text, tone = "" }: { text?: string | undefined; tone?: "ok" | "bad" | "" }) {
  if (!text) return null;
  return <output className={`notice ${tone}`}>{text}</output>;
}

/** Reloads the page every few seconds while a payment is still pending. */
export function AutoRefresh({ when, seconds = 3 }: { when: boolean; seconds?: number }) {
  return when ? <meta httpEquiv="refresh" content={String(seconds)} /> : null;
}
