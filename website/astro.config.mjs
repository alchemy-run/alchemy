// @ts-check
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import starlightBlog from "starlight-blog";

/**
 * Copies `src/content/docs/**\/*.{md,mdx}` into the build output dir, preserving
 * the directory layout but normalizing extensions to `.md`. This lets the worker
 * serve raw markdown for clients (e.g. coding agents) that prefer it.
 *
 * @returns {import("astro").AstroIntegration}
 */
function copyMarkdownSources() {
  return {
    name: "copy-markdown-sources",
    hooks: {
      "astro:build:done": async ({ dir }) => {
        const srcDir = fileURLToPath(
          new URL("./src/content/docs/", import.meta.url),
        );
        const outDir = fileURLToPath(dir);

        /** @param {string} current */
        async function walk(current) {
          const entries = await fs.readdir(current, { withFileTypes: true });
          for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
              await walk(full);
              continue;
            }
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (ext !== ".md" && ext !== ".mdx") continue;
            const rel = path.relative(srcDir, full);
            const target = path.join(
              outDir,
              rel.slice(0, rel.length - ext.length) + ".md",
            );
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(full, target);
          }
        }

        await walk(srcDir);
      },
    },
  };
}

export default defineConfig({
  site: "https://alchemy.run",
  prefetch: true,
  trailingSlash: "ignore",
  integrations: [
    copyMarkdownSources(),
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
      components: {
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeProvider.astro",
      },
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
        { label: "What is Alchemy?", link: "/what-is-alchemy" },
        { label: "Getting Started", link: "/getting-started" },
        {
          label: "Tutorial",
          autogenerate: { directory: "tutorial" },
        },
        {
          label: "Concepts",
          autogenerate: { directory: "concepts" },
        },
        {
          label: "Guides",
          autogenerate: { directory: "guides" },
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
