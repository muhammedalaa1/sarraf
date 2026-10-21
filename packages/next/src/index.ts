import {
  defaultLogger,
  isSarrafError,
  type Logger,
  type ProviderId,
  type RedirectResult,
  type Sarraf,
  type SarrafEvent,
} from "@sarraf/core";

/** A Sarraf client, or a function returning one (for clients created lazily, e.g. on first request). */
export type SarrafSource = Sarraf | (() => Sarraf);

type ParamValue = string | string[] | undefined;
type Params = Record<string, ParamValue>;

/** The second argument Next.js passes to a route handler. `params` is a Promise since Next 15. */
export interface RouteContext {
  params?: Promise<Params> | Params | undefined;
}

export interface WebhookRouteOptions {
  /** Dynamic segment holding the provider id. Default "provider". Ignored when `provider` is set. */
  param?: string | undefined;
  /** Fixed provider for this route, e.g. for `app/api/webhooks/paymob/route.ts`. */
  provider?: ProviderId | undefined;
  /**
   * Run `onEvent` after the response is sent. Pass Next's `after` (from "next/server"), or
   * `ctx.waitUntil` on other runtimes. The provider gets 200 as soon as the signature is valid,
   * so a failure in `onEvent` is only logged: use it to enqueue work, not to do it.
   * Default: run `onEvent` first, and answer 500 if it throws so the provider retries.
   */
  defer?: ((task: () => Promise<void>) => void) | undefined;
  logger?: Logger | undefined;
}

export type RouteHandler = (req: Request, context?: RouteContext) => Promise<Response>;

/**
 * Route handler that verifies, normalizes and dispatches provider webhooks. It reads the exact
 * body with `req.text()`, so signatures are checked over the bytes the provider sent.
 *
 * ```ts
 * // app/api/webhooks/[provider]/route.ts
 * export const POST = webhookRoute(pay, async (event) => {
 *   await markOrder(event.payment.reference, event.payment.status); // dedupe on event.id
 * });
 * ```
 *
 * Answers 404 for an unknown provider, 400 for an invalid signature, 500 when processing fails.
 * Uses only the Fetch API `Request` / `Response`, so it also works in any Fetch-based framework.
 */
export function webhookRoute(
  pay: SarrafSource,
  onEvent: (event: SarrafEvent) => unknown,
  options: WebhookRouteOptions = {},
): RouteHandler {
  const logger = options.logger ?? defaultLogger;
  return async (req, context) => {
    const client = resolve(pay);
    const provider = options.provider ?? first((await context?.params)?.[options.param ?? "provider"]);
    if (!provider || !client.providerIds.includes(provider as ProviderId)) {
      return Response.json({ error: "UNKNOWN_PROVIDER" }, { status: 404 });
    }
    let event: SarrafEvent;
    try {
      event = await client.webhooks.verifyAndParse(provider as ProviderId, {
        headers: req.headers,
        rawBody: await req.text(),
        query: Object.fromEntries(new URL(req.url).searchParams),
      });
    } catch (err) {
      if (isSarrafError(err, "WEBHOOK_SIGNATURE_INVALID")) {
        logger.warn(`rejected ${provider} webhook`, { reason: err.message });
        return Response.json({ error: "WEBHOOK_SIGNATURE_INVALID" }, { status: 400 });
      }
      logger.error(`failed to process ${provider} webhook`, { error: String(err) });
      return Response.json({ error: "WEBHOOK_PROCESSING_FAILED" }, { status: 500 });
    }
    if (options.defer) {
      options.defer(async () => {
        try {
          await onEvent(event);
        } catch (err) {
          logger.error(`onEvent failed after ack for ${event.id}`, { error: String(err) });
        }
      });
      return Response.json({ received: true, id: event.id });
    }
    try {
      await onEvent(event);
    } catch (err) {
      logger.error(`onEvent failed for ${event.id}; answering 500 so the provider retries`, {
        error: String(err),
      });
      return Response.json({ error: "HANDLER_FAILED" }, { status: 500 });
    }
    return Response.json({ received: true, id: event.id });
  };
}

/** What a page receives as `searchParams`, or anything `URLSearchParams` accepts. */
export type SearchParamsInput =
  | Promise<Params>
  | Params
  | URLSearchParams
  | string
  | Promise<URLSearchParams | string>;

/**
 * Read the params a provider appends to `returnUrl` on a thank-you page. **For UX only**: never
 * fulfil an order from it, use the webhook or a status query.
 *
 * Unlike `pay.redirects.verify`, it never throws for a provider that does not sign redirects
 * (Fawry) or is not configured: it returns `authenticated: false, status: "unknown"`.
 *
 * ```ts
 * export default async function Thanks({ params, searchParams }) {
 *   const { provider } = await params;
 *   const result = await verifyRedirect(pay, provider, searchParams);
 *   if (result.authenticated && result.status === "failed") return <TryAgain />;
 * }
 * ```
 */
export async function verifyRedirect(
  pay: SarrafSource,
  provider: string,
  searchParams: SearchParamsInput,
): Promise<RedirectResult> {
  const client = resolve(pay);
  const query = toQuery(await searchParams);
  const unverified: RedirectResult = {
    provider: provider as ProviderId,
    authenticated: false,
    status: "unknown",
    reference: query.reference,
    raw: query,
  };
  if (!client.providerIds.includes(provider as ProviderId)) return unverified;
  try {
    return await client.redirects.verify(provider as ProviderId, query);
  } catch (err) {
    if (isSarrafError(err, "CAPABILITY_NOT_SUPPORTED")) return unverified;
    throw err;
  }
}

function resolve(pay: SarrafSource): Sarraf {
  return typeof pay === "function" ? pay() : pay;
}

function first(value: ParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Repeated keys keep their first value, as provider signatures are computed over single values. */
function toQuery(input: Params | URLSearchParams | string): Record<string, string> {
  const query: Record<string, string> = {};
  const entries =
    typeof input === "string" || input instanceof URLSearchParams
      ? [...new URLSearchParams(input)]
      : Object.entries(input);
  for (const [key, value] of entries) {
    const v = first(value);
    if (v !== undefined && !(key in query)) query[key] = v;
  }
  return query;
}
