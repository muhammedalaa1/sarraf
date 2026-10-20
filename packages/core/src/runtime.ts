/**
 * Sarraf handles secret keys and must never run in a browser. Throw early and clearly.
 */
export function assertServerRuntime(g: Record<string, unknown> = globalThis): void {
  const isBrowser = typeof g.window === "object" && typeof g.document === "object";
  const proc = g.process as { versions?: { node?: string } } | undefined;
  const isNodeLike = typeof proc?.versions?.node === "string";
  if (isBrowser && !isNodeLike) {
    throw new Error(
      "@sarraf/core is server-side only: it uses secret API keys. Import it in your backend, never in browser code.",
    );
  }
}
