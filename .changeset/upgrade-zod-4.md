---
"@sarraf/core": minor
"@sarraf/paymob": minor
"@sarraf/kashier": minor
"@sarraf/fawry": minor
"@sarraf/express": patch
"@sarraf/testing": patch
---

**Requires Node.js 22 or later** (was 18). Node 18 and 20 are end-of-life and no longer tested.

Upgrade to zod 4. Option validation behaves the same: Paymob `integrationIds` still accepts any subset of payment methods, and an unsupported currency still throws `UNSUPPORTED_CURRENCY`. Validation error messages may be worded differently. `@sarraf/express` is now tested against Express 5.
