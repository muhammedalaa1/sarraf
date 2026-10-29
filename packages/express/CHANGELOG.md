# @sarrafjs/express

## 0.2.1

### Patch Changes

- 0e0bd0d: Point `docsUrl` and every README at the docs site, https://sarraf-docs.vercel.app (the old sarraf.dev links were dead), add `homepage` and `bugs` to each package, and expand the npm READMEs with setup, options and examples.
- Updated dependencies [0e0bd0d]
  - @sarrafjs/core@0.2.1

## 0.2.0

### Patch Changes

- 0ebf532: Packages are published under the `@sarrafjs` npm scope (`npm i @sarrafjs/core @sarrafjs/paymob`). Point `repository`, `homepage` and `bugs` at github.com/muhammedalaa1/sarraf, the repository the packages are built and published from (npm provenance checks that they match).
- 20a3ec0: **Requires Node.js 22 or later** (was 18). Node 18 and 20 are end-of-life and no longer tested.
  
  Upgrade to zod 4. Option validation behaves the same: Paymob `integrationIds` still accepts any subset of payment methods, and an unsupported currency still throws `UNSUPPORTED_CURRENCY`. Validation error messages may be worded differently. `@sarrafjs/express` is now tested against Express 5.
- Updated dependencies [ba96437]
- Updated dependencies [0ebf532]
- Updated dependencies [20a3ec0]
  - @sarrafjs/core@0.2.0
