<!-- PR title: type(scope): subject, e.g. "fix(kashier): sort keys before signing". CI checks it; see CONTRIBUTING.md#commit-messages-and-pr-titles -->

## What

<!-- What does this change and why? Link issues. -->

## How I verified it

- [ ] Unit / signature / conformance tests added or updated
- [ ] `pnpm check` passes locally (lint, typecheck, tests, package checks, secret scan)
- [ ] Sandbox: <!-- describe real sandbox calls, or "n/a" -->
- [ ] Changeset added (`pnpm changeset`) for published packages

## Safety checklist

- [ ] No credentials, customer data or full card numbers in code, fixtures or logs
- [ ] Money-moving calls are not retried automatically
- [ ] Unverified provider behavior is marked ⚠️ / `"beta"`
- [ ] No `any`, `@ts-ignore`, `!` non-null assertions or `biome-ignore` added without a written reason
- [ ] If the public API changed: `public-api` snapshot updated and the changeset bump matches (removal/rename = major)
