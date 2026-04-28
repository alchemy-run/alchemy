// @ts-check
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import astroBrokenLinksChecker from "astro-broken-links-checker";
import { defineConfig } from "astro/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import starlightBlog from "starlight-blog";
import { pagefindIgnoreNoise } from "./plugins/pagefind-ignore-noise.mjs";

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
        const outDir = fileURLToPath(dir);

        /**
         * @param {string} srcDir
         * @param {string} relTo
         */
        async function walk(srcDir, relTo = srcDir) {
          let entries;
          try {
            entries = await fs.readdir(srcDir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            const full = path.join(srcDir, entry.name);
            if (entry.isDirectory()) {
              await walk(full, relTo);
              continue;
            }
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (ext !== ".md" && ext !== ".mdx") continue;
            const rel = path.relative(relTo, full);
            const target = path.join(
              outDir,
              rel.slice(0, rel.length - ext.length) + ".md",
            );
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(full, target);
          }
        }

        // Docs (Starlight content collection) — preserves nested layout under
        // /content/docs/ → /<path>.md
        await walk(
          fileURLToPath(new URL("./src/content/docs/", import.meta.url)),
        );
        // Marketing pages (top-level Astro pages) — exposes /<page>.md so
        // agents can fetch raw MDX via the worker's content negotiation.
        await walk(fileURLToPath(new URL("./src/pages/", import.meta.url)));
      },
    },
  };
}

export default defineConfig({
  site: "https://v2.alchemy.run",
  prefetch: true,
  trailingSlash: "ignore",
  integrations: [
    react(),
    pagefindIgnoreNoise(),
    copyMarkdownSources(),
    astroBrokenLinksChecker({
      checkExternalLinks: false,
      throwError: true,
    }),
    sitemap({
      filter: (page) =>
        !page.endsWith(".html") &&
        !page.endsWith(".md") &&
        !page.endsWith(".mdx"),
    }),
    starlight({
      title: "alchemy",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/global.css", "./src/styles/custom.css"],
      components: {
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeProvider.astro",
        Header: "./src/components/marketing/Nav.astro",
        Head: "./src/components/starlight/Head.astro",
      },
      prerender: true,
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/alchemy-run/alchemy-effect",
        },
      ],
      editLink: {
        baseUrl:
          "https://github.com/alchemy-run/alchemy-effect/edit/main/website",
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
    mdx(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
