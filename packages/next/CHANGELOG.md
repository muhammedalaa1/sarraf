# @sarrafjs/next

## 0.2.0

### Minor Changes

- 1c78722: New packages. `@sarrafjs/next`: `webhookRoute()` turns provider webhooks into a verified App Router route handler, and `verifyRedirect()` reads thank-you page params without throwing for providers that don't sign redirects. `@sarrafjs/nestjs`: `SarrafModule.forRoot()` / `forRootAsync()` registers the client (`@InjectSarraf()`) and a `POST /webhooks/:provider` controller that dispatches verified events to `@OnSarrafEvent()` methods.

### Patch Changes

- 0ebf532: Packages are published under the `@sarrafjs` npm scope (`npm i @sarrafjs/core @sarrafjs/paymob`). Point `repository`, `homepage` and `bugs` at github.com/muhammedalaa1/sarraf, the repository the packages are built and published from (npm provenance checks that they match).
- Updated dependencies [ba96437]
- Updated dependencies [0ebf532]
- Updated dependencies [20a3ec0]
  - @sarrafjs/core@0.2.0
