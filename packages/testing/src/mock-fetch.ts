import type { FetchLike } from "@sarraf/core";

export interface MockRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string | undefined;
  /** Parsed JSON body, or undefined. */
  json?: unknown;
}

export interface MockResponse {
  status?: number | undefined;
  body?: unknown;
  headers?: Record<string, string> | undefined;
}

export interface MockRoute {
  method?: string | undefined;
  /** Matches the full URL (string = exact path match on pathname, RegExp = tested on the full href). */
  url: string | RegExp;
  respond: MockResponse | ((req: MockRequest) => MockResponse | Promise<MockResponse>);
  /** Respond only this many times, then fall through to the next matching route. */
  times?: number | undefined;
}

export interface MockFetch extends FetchLike {
  calls: MockRequest[];
  /** Calls matching a method and path. */
  callsTo(method: string, pathOrRegex: string | RegExp): MockRequest[];
  reset(): void;
}

/**
 * A tiny router-based fetch replacement for adapter tests. Unmatched requests throw
 * with a helpful message instead of hitting the network.
 */
export function createMockFetch(routes: MockRoute[]): MockFetch {
  const calls: MockRequest[] = [];
  const used = new Map<MockRoute, number>();

  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers as Record<string, string> | undefined) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    const body = typeof init.body === "string" ? init.body : undefined;
    let json: unknown;
    if (body) {
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
    }
    const req: MockRequest = { method, url, headers, body, json };
    calls.push(req);

    const route = routes.find((r) => {
      if (r.method && r.method.toUpperCase() !== method) return false;
      if (r.times !== undefined && (used.get(r) ?? 0) >= r.times) return false;
      return matches(r.url, url);
    });
    if (!route) {
      throw new Error(
        `createMockFetch: no route for ${method} ${url.href}. Routes: ${routes
          .map((r) => `${r.method ?? "*"} ${String(r.url)}`)
          .join(", ")}`,
      );
    }
    used.set(route, (used.get(route) ?? 0) + 1);
    const res = typeof route.respond === "function" ? await route.respond(req) : route.respond;
    const payload =
      res.body === undefined ? null : typeof res.body === "string" ? res.body : JSON.stringify(res.body);
    return new Response(payload, {
      status: res.status ?? 200,
      headers: { "content-type": "application/json", ...res.headers },
    });
  }) as MockFetch;

  fetchImpl.calls = calls;
  fetchImpl.callsTo = (method, path) =>
    calls.filter((c) => c.method === method.toUpperCase() && matches(path, c.url));
  fetchImpl.reset = () => {
    calls.length = 0;
    used.clear();
  };
  return fetchImpl;
}

function matches(pattern: string | RegExp, url: URL) {
  return typeof pattern === "string"
    ? url.pathname === pattern || url.href === pattern
    : pattern.test(url.href);
}
