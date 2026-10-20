---
title: Money
description: Integer minor units, 2- and 3-decimal currencies, and per-provider formatting.
sidebar:
  order: 1
---

Every amount in Sarraf is a `Money` object in **integer minor units**:

```ts
{ value: 25000, currency: "EGP" }   // 250.00 EGP
{ value: 1250,  currency: "KWD" }   // 1.250 KWD
```

| Exponent | Currencies |
|---|---|
| 2 | EGP, SAR, AED, QAR, USD, EUR |
| **3** | **KWD, BHD, OMR, JOD** |

Convert with string math, never `Number` division:

```ts
import { toMinor, toMajorString } from "@sarraf/core";

toMinor("250.00", "EGP");      // 25000
toMajorString(25000, "EGP");   // "250.00"
toMinor("1.250", "KWD");       // 1250
toMinor("10.505", "EGP");      // throws: more than 2 decimal places
```

Floats like `250.5` are rejected as amounts (`INVALID_REQUEST`). Validation also checks that `items` add up to `amount`.

## Provider formats (handled for you)

| Provider | Wire format | Example |
|---|---|---|
| Paymob | integer cents | `25000` |
| Kashier | major-unit string, identical in hash and URL | `"250.00"` (or `"250"` with `amountFormat: "trimmed"`) |
| Fawry | major units, **exactly two decimals** in signatures | `"250.00"` |

Fawry signatures break on `250` vs `250.00`, and JSON parsers turn `250.00` into `250`. Sarraf re-formats amounts with string math before it hashes them.
