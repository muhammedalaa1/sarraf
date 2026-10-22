---
title: Sandbox dashboard
description: Playground, webhook inbox, status explorer and capability matrix.
sidebar:
  order: 5
---

`apps/dashboard` is a Next.js app for working against provider **sandboxes**.

```bash
cp .env.sandbox.example .env.sandbox     # sandbox keys only
pnpm --filter @sarrafjs/dashboard dev      # http://localhost:4545
cloudflared tunnel --url http://localhost:4545
```

Point sandbox callback URLs at `https://<tunnel>/webhooks/<provider>` and set `SANDBOX_PUBLIC_URL` so checkouts send that URL too.

- **Playground**: pick a provider, method and amount, then create a checkout. The request (redacted), raw response and normalized object appear side by side.
- **Webhook inbox**: every incoming webhook with ✓/✗, the **exact string that was hashed**, expected vs received signatures, the raw payload and the normalized event. **Replay** re-runs verification (useful after fixing a secret).
- **Status explorer**: each provider's mapping table.
- **Capabilities**: live `pay.capabilities()`.

Safety: the dashboard refuses anything that looks like a live key, rate-limits checkout and webhook endpoints, deletes inbox entries after 7 days, and shows a "Sandbox, no real money" banner on every screen. Without credentials it runs in demo mode with fake providers.

Capture real webhooks as committed fixtures with `pnpm record-fixtures webhook`.
