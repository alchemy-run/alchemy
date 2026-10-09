import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

/**
 * Emits `/search-sitemap.xml`: every rendered docs page, for the AI Search
 * web crawler (see `alchemy.run.ts`).
 *
 * The public `sitemap-index.xml` deliberately omits `noindex` pages — which
 * includes most generated API reference pages — so crawling it would leave
 * the reference out of docs search. This sitemap lists them all, minus
 * pages that are never search results (redirect stubs, 404, auth callbacks,
 * paginated blog listings).
 *
 * URLs are baked against `site`; the Worker rewrites them to the request's
 * origin so a non-production stage's crawler indexes that stage.
 */
export function searchSitemap(): AstroIntegration {
  let site = "https://alchemy.run";
  return {
    name: "search-sitemap",
    hooks: {
      "astro:config:done": ({ config }) => {
        if (config.site) site = config.site.replace(/\/$/, "");
      },
      "astro:build:done": async ({ dir }) => {
        const outDir = fileURLToPath(dir);
        const entries = await fs.readdir(outDir, { recursive: true, withFileTypes: true });
        const pages = await Promise.all(
          entries
            .filter((entry) => entry.isFile() && entry.name === "index.html")
            .map(async (entry) => {
              const rel = path.relative(outDir, entry.parentPath).split(path.sep).join("/");
              const pathname = rel === "" ? "/" : `/${rel}/`;
              if (EXCLUDE.some((re) => re.test(pathname))) return undefined;
              const html = await fs.readFile(path.join(entry.parentPath, entry.name), "utf8");
              // Astro `redirects` render as meta-refresh stubs.
              if (/<meta\s+http-equiv="refresh"/i.test(html)) return undefined;
              return pathname;
            }),
        );
        const urls = pages.filter((p): p is string => p !== undefined).sort();
        const xml = [
          `<?xml version="1.0" encoding="UTF-8"?>`,
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
          ...urls.map((p) => `<url><loc>${site}${p}</loc></url>`),
          `</urlset>`,
          "",
        ].join("\n");
        await fs.writeFile(path.join(outDir, "search-sitemap.xml"), xml);
      },
    },
  };
}

const EXCLUDE = [
  /^\/404\/$/,
  /^\/auth\//,
  /^\/og\//,
  /^\/blog\/\d+\/$/,
  /^\/blog\/(tags|authors)\//,
];
