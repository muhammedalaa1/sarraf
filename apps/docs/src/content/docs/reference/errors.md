---
title: Errors
description: SarrafError codes and what to do about them.
---

Every failure is a `SarrafError` with a stable `code`, plus `provider`, `providerCode`, `retryable` and (when relevant) `docsUrl`.

| Code | Meaning | What to do |
|---|---|---|
| `CONFIGURATION_INVALID` | Bad or missing options | Fix config; the message lists the fields |
| `AUTHENTICATION_FAILED` | Provider rejected the keys | Check keys, and test vs live mode |
| `INVALID_REQUEST` | Input failed validation or the provider rejected it | Fix the input |
| `UNSUPPORTED_CURRENCY` | Provider or region does not take this currency | Pick another provider or currency |
| `CAPABILITY_NOT_SUPPORTED` | Feature missing, or beta without `allowBeta` | See `docsUrl` |
| `PAYMENT_DECLINED` | Declined (appears in `payment.failure`) | Ask the customer to retry |
| `DUPLICATE_REFERENCE` | Reference already used | Use a new reference per attempt |
| `NOT_FOUND` | Unknown payment or order | Check the id or reference |
| `RATE_LIMITED` | Too many requests | Back off (`retryable: true`) |
| `PROVIDER_UNAVAILABLE` | Provider 5xx | Retry later (`retryable: true`) |
| `TIMEOUT_UNKNOWN_OUTCOME` | A money call timed out | **Query status. Do not retry blindly** |
| `WEBHOOK_SIGNATURE_INVALID` | Signature mismatch | Answer 400; use `webhooks.inspect()` to debug |
| `NETWORK_ERROR` | Network failure on a read call | Retry |
