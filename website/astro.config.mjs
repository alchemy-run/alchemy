// @ts-check
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import starlightBlog from "starlight-blog";

export default defineConfig({
  site: "https://alchemy.run",
  prefetch: true,
  trailingSlash: "ignore",
  integrations: [
    sitemap({
      filter: (page) =>
        !page.endsWith(".html") &&
        !page.endsWith(".md") &&
        !page.endsWith(".mdx"),
    }),
    starlight({
      title: "alchemy",
      favicon: "/favicon.png",
      customCss: ["./src/styles/global.css", "./src/styles/custom.css"],
      prerender: true,
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/alchemy-run/alchemy",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/alchemy-run/alchemy/edit/main/website",
      },
      sidebar: [
        { label: "Getting Started", link: "/getting-started" },
        { label: "What is Alchemy?", link: "/what-is-alchemy" },
        {
          label: "Concepts",
          autogenerate: { directory: "concepts" },
        },
        {
          label: "Guides",
          items: [
            { label: "Migrating from v1", link: "/guides/migrating-from-v1" },
            {
              label: "Plan, Deploy and Destroy",
              link: "/guides/plan-deploy-destroy",
            },
            { label: "Continuous Integration", link: "/guides/ci" },
            { label: "Testing", link: "/guides/testing" },
            {
              label: "Effect",
              autogenerate: { directory: "guides/effect" },
              collapsed: true,
            },
            {
              label: "Async",
              autogenerate: { directory: "guides/async" },
              collapsed: true,
            },
            {
              label: "Frameworks",
              autogenerate: { directory: "guides/frameworks" },
              collapsed: true,
            },
          ],
        },
        {
          label: "Providers",
          autogenerate: { directory: "providers", collapsed: true },
        },
      ],
      plugins: [starlightBlog()],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
