import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://sarraf.dev",
  integrations: [
    starlight({
      title: "Sarraf",
      description: "One payment API for Egypt and the Middle East: Paymob, Kashier, Fawry.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/sarraf-dev/sarraf" }],
      editLink: { baseUrl: "https://github.com/sarraf-dev/sarraf/edit/main/apps/docs/" },
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
