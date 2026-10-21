/** @type {import('next').NextConfig} */
export default {
  // Sarraf is server-only; keep it out of client bundles.
  serverExternalPackages: [
    "@sarraf/core",
    "@sarraf/paymob",
    "@sarraf/kashier",
    "@sarraf/fawry",
    "@sarraf/next",
    "@sarraf/testing",
  ],
};
