---
"@sarraf/next": minor
"@sarraf/nestjs": minor
---

New packages. `@sarraf/next`: `webhookRoute()` turns provider webhooks into a verified App Router route handler, and `verifyRedirect()` reads thank-you page params without throwing for providers that don't sign redirects. `@sarraf/nestjs`: `SarrafModule.forRoot()` / `forRootAsync()` registers the client (`@InjectSarraf()`) and a `POST /webhooks/:provider` controller that dispatches verified events to `@OnSarrafEvent()` methods.
