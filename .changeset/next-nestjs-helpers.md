---
"@sarrafjs/next": minor
"@sarrafjs/nestjs": minor
---

New packages. `@sarrafjs/next`: `webhookRoute()` turns provider webhooks into a verified App Router route handler, and `verifyRedirect()` reads thank-you page params without throwing for providers that don't sign redirects. `@sarrafjs/nestjs`: `SarrafModule.forRoot()` / `forRootAsync()` registers the client (`@InjectSarraf()`) and a `POST /webhooks/:provider` controller that dispatches verified events to `@OnSarrafEvent()` methods.
