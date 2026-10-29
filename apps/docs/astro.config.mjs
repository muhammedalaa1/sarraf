import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// The public URL: SITE_URL (e.g. a custom domain), else the Vercel production URL, else the public docs site.
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const site = process.env.SITE_URL ?? (vercelUrl ? `https://${vercelUrl}` : "https://sarraf-docs.vercel.app");
// The GitHub repo for the header link and "Edit page" links (same org as package.json `repository`).
const repo = "https://github.com/muhammedalaa1/sarraf";

export default defineConfig({
  site,
  integrations: [
    starlight({
      title: "Sarraf",
      description: "One payment API for Egypt and the Middle East: Paymob, Kashier, Fawry.",
      social: [{ icon: "github", label: "GitHub", href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/apps/docs/` },
      sidebar: [
        {
          label: "Getting started",
          items: [{ slug: "getting-started/quick-start" }, { slug: "getting-started/not-affiliated" }],
        },
        { label: "Concepts", items: [{ autogenerate: { directory: "concepts" } }] },
        { label: "Providers", items: [{ autogenerate: { directory: "providers" } }] },
        { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
        {
          label: "Reference",
          items: [{ slug: "reference/errors" }, { label: "API reference (TypeDoc)", link: "/api/" }],
        },
      ],
    }),
  ],
});
