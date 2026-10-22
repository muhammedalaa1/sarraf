# Security Policy

Sarraf handles payment provider credentials and webhook signatures, so we take security reports seriously.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting ("Report a vulnerability" under the Security tab of this repository). Please include:

- affected package(s) and version(s)
- a description of the issue and its impact
- steps to reproduce, or a proof of concept that uses sandbox credentials only

We aim to acknowledge reports within 3 business days and to ship a fix or mitigation for confirmed issues as fast as practical. We credit reporters who want credit.

## Scope

In scope: signature verification bypasses, secret leakage (logs, errors, redaction gaps), idempotency flaws that could cause double charges or refunds, and dependency issues that affect Sarraf.

Out of scope: vulnerabilities in the payment providers themselves (report those to the provider), and issues that need already-compromised merchant credentials.

## Supported versions

The latest minor version of each `@sarrafjs/*` package receives security fixes.

## Design safeguards

- Constant-time signature comparison; webhooks are verified over the raw request body.
- Automatic redaction of keys, tokens, signatures, emails and phone numbers in logs and hooks.
- Money-moving calls are never retried automatically after a timeout (`TIMEOUT_UNKNOWN_OUTCOME`).
- No API accepts card numbers or CVVs.
- npm releases are published with provenance from GitHub Actions.
