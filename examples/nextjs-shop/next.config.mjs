/** @type {import('next').NextConfig} */
export default {
  // Sarraf is server-only; keep it out of client bundles.
  serverExternalPackages: [
    "@sarrafjs/core",
    "@sarrafjs/paymob",
    "@sarrafjs/kashier",
    "@sarrafjs/fawry",
    "@sarrafjs/next",
    "@sarrafjs/testing",
  ],
};
