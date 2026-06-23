// @ts-check
import { unified } from "@astrojs/markdown-remark";
import mdx from "@astrojs/mdx";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import astroBrokenLinksChecker from "astro-broken-links-checker";
import { defineConfig } from "astro/config";
import { promises as fs, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import starlightBlog from "starlight-blog";
import { pagefindIgnoreNoise } from "./plugins/pagefind-ignore-noise.mjs";

/**
 * The Providers sidebar (Provider → Category → Service → Resource) is generated
 * by `scripts/generate-api-reference.ts` from `@category` JSDoc annotations and
 * written to `src/generated/providers-sidebar.json`. `bun run build:reference`
 * regenerates it before every build. If it hasn't been generated yet (e.g. a
 * fresh `astro dev` before running the generator), fall back to autogenerating
 * from the directory tree so the docs still build.
 */
function providersSidebarEntry() {
  const json = readFileSync(
    fileURLToPath(
      new URL("./src/generated/providers-sidebar.json", import.meta.url),
    ),
    "utf8",
  );
  // Expanded one level deep: the Providers group shows its providers
  // (AWS, Cloudflare, …) on load; everything below stays collapsed.
  return { label: "Providers", collapsed: false, items: JSON.parse(json) };
}

const DOCS_ROOT = fileURLToPath(
  new URL("./src/content/docs/", import.meta.url),
);

/**
 * Minimal YAML front-matter reader. Extracts only the fields the sidebar cares
 * about: top-level `title` and the nested `sidebar.order` / `sidebar.label`.
 * Avoids pulling in a full YAML parser for the handful of scalar values we use.
 *
 * @param {string} source raw file contents
 * @returns {{ title?: string, order?: number, label?: string }}
 */
function readFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  /** @type {{ title?: string, order?: number, label?: string }} */
  const result = {};
  let inSidebar = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inSidebar = false;
      const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!top) continue;
      const [, key, rawValue] = top;
      if (key === "sidebar" && rawValue.trim() === "") {
        inSidebar = true;
      } else if (key === "title") {
        result.title = unquote(rawValue);
      }
      continue;
    }
    if (!inSidebar) continue;
    const nested = line.trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!nested) continue;
    const [, key, rawValue] = nested;
    if (key === "order") {
      const num = Number(unquote(rawValue));
      if (!Number.isNaN(num)) result.order = num;
    } else if (key === "label") {
      result.label = unquote(rawValue);
    }
  }
  return result;
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Replacement for Starlight's removed `autogenerate` sidebar option. Reads a
 * directory under `src/content/docs`, parses each entry's front matter for its
 * `title` and `sidebar.order`, and produces a Starlight `items` array.
 *
 * Sorting mirrors Starlight: ascending by `sidebar.order` (unset sorts last),
 * ties broken alphabetically by label. Subdirectories become collapsed groups.
 *
 * @param {string} directory directory relative to `src/content/docs`
 * @returns {Array<{ label: string, link: string } | { label: string, collapsed: boolean, items: any[] }>}
 */
function autogenerate(directory) {
  const absDir = path.join(DOCS_ROOT, directory);
  const entries = readdirSync(absDir, { withFileTypes: true });

  /** @type {Array<{ order: number, label: string, entry: any }>} */
  const items = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const childDir = `${directory}/${entry.name}`;
      items.push({
        order: Number.MAX_VALUE,
        label: entry.name,
        entry: {
          label: entry.name,
          collapsed: true,
          items: autogenerate(childDir),
        },
      });
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (ext !== ".md" && ext !== ".mdx") continue;
    const slug = entry.name.slice(0, entry.name.length - ext.length);
    if (slug.toLowerCase() === "index") continue;

    const source = readFileSync(path.join(absDir, entry.name), "utf8");
    const { title, order, label } = readFrontmatter(source);
    const displayLabel = label ?? title ?? slug;
    // Starlight lowercases doc URLs, so build links from the lowercased path.
    const link = `/${directory}/${slug}`.toLowerCase();
    items.push({
      order: order ?? Number.MAX_VALUE,
      label: displayLabel,
      entry: { label: displayLabel, link },
    });
  }

  items.sort((a, b) =>
    a.order !== b.order
      ? a.order - b.order
      : a.label.localeCompare(b.label, "en", { numeric: true }),
  );

  return items.map((item) => item.entry);
}

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
         * @param {{ lowercase?: boolean }} [opts]
         * @param {string} [relTo]
         */
        async function walk(srcDir, opts = {}, relTo = srcDir) {
          let entries;
          try {
            entries = await fs.readdir(srcDir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            const full = path.join(srcDir, entry.name);
            if (entry.isDirectory()) {
              await walk(full, opts, relTo);
              continue;
            }
            if (!entry.isFile()) continue;
            const ext = path.extname(entry.name).toLowerCase();
            if (ext !== ".md" && ext !== ".mdx") continue;
            let rel = path.relative(relTo, full);
            rel = rel.slice(0, rel.length - ext.length) + ".md";
            // Starlight lowercases doc URLs (e.g. CamelCase source
            // `providers/AWS/S3/Bucket.md` is served at `/providers/aws/s3/bucket`),
            // so the raw-markdown copy must live at the lowercased path or the
            // worker's `/providers/aws/s3/bucket.md` lookup 404s into HTML.
            if (opts.lowercase) rel = rel.toLowerCase();
            const target = path.join(outDir, rel);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(full, target);
          }
        }

        // Docs (Starlight content collection) — preserves nested layout under
        // /content/docs/ → /<path>.md, lowercased to match Starlight's URLs.
        await walk(
          fileURLToPath(new URL("./src/content/docs/", import.meta.url)),
          { lowercase: true },
        );
        // Marketing pages (top-level Astro pages) — exposes /<page>.md so
        // agents can fetch raw MDX via the worker's content negotiation. Astro
        // page routing preserves case, so don't lowercase these.
        await walk(fileURLToPath(new URL("./src/pages/", import.meta.url)));
      },
    },
  };
}

/**
 * Case-sensitive internal-link checker. astro-broken-links-checker uses
 * `fs.existsSync`, which is case-insensitive on macOS — so `/foo/Bar` will
 * resolve to `/foo/bar` locally but 404 on Linux CI. This integration walks
 * the build output once into a case-sensitive Set of paths and validates
 * every `href`/`src` against it.
 *
 * @returns {import("astro").AstroIntegration}
 */
function caseSensitiveLinkChecker() {
  return {
    name: "case-sensitive-link-checker",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const distPath = fileURLToPath(dir);

        /** @type {Set<string>} */
        const paths = new Set();
        /** @type {Set<string>} */
        const dirs = new Set();
        /**
         * @param {string} d
         */
        async function walk(d) {
          const entries = await fs.readdir(d, { withFileTypes: true });
          for (const entry of entries) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
              dirs.add("/" + path.relative(distPath, full));
              await walk(full);
            } else if (entry.isFile()) {
              paths.add("/" + path.relative(distPath, full));
            }
          }
        }
        await walk(distPath);

        /** @type {Map<string, Set<string>>} */
        const broken = new Map();
        const htmlFiles = [...paths].filter((p) => p.endsWith(".html"));

        for (const htmlFile of htmlFiles) {
          const html = await fs.readFile(
            path.join(distPath, htmlFile.slice(1)),
            "utf8",
          );
          const links = [
            ...html.matchAll(/<a\s+[^>]*href="([^"#?]+)/gi),
            ...html.matchAll(/<img\s+[^>]*src="([^"#?]+)/gi),
          ].map((m) => m[1]);

          for (const link of links) {
            if (!link.startsWith("/")) continue; // skip external, anchors, mailto, etc.
            const clean = link.replace(/\/$/, "");
            const fileCandidates = [
              clean,
              clean + "/index.html",
              clean + ".html",
            ];
            const exists =
              fileCandidates.some((c) => paths.has(c)) || dirs.has(clean);
            if (!exists) {
              if (!broken.has(link)) broken.set(link, new Set());
              broken.get(link)?.add(htmlFile);
            }
          }
        }

        if (broken.size > 0) {
          let msg = "Case-sensitive broken links detected:\n";
          for (const [link, docs] of broken.entries()) {
            msg += `\n  ${link}\n    Found in:\n`;
            for (const doc of docs) msg += `      - ${doc}\n`;
          }
          logger.error(msg);
          throw new Error(
            `Case-sensitive broken links detected (${broken.size})`,
          );
        }
        logger.info(
          `Case-sensitive link check passed (${htmlFiles.length} pages)`,
        );
      },
    },
  };
}

export default defineConfig({
  site: "https://v2.alchemy.run",
  prefetch: true,
  trailingSlash: "ignore",
  // Astro 7 switched the default Markdown processor to Sätteri (native), which
  // does not run remark/rehype plugins. Starlight and Expressive Code register
  // such plugins (heading anchors, asides/directives, code highlighting), so we
  // keep the unified() pipeline as the processor or those features silently
  // stop running. See https://docs.astro.build/en/guides/upgrade-to/v7/.
  markdown: {
    processor: unified(),
  },
  integrations: [
    react(),
    pagefindIgnoreNoise(),
    copyMarkdownSources(),
    astroBrokenLinksChecker({
      checkExternalLinks: false,
      throwError: true,
    }),
    caseSensitiveLinkChecker(),
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
        {
          icon: "discord",
          label: "Discord",
          href: "https://discord.gg/jwKw8dBJdN",
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
          items: [
            { label: "Part 1: Your First Stack", link: "/tutorial/part-1" },
            { label: "Part 2: Add a Worker", link: "/tutorial/part-2" },
            { label: "Part 3: Testing", link: "/tutorial/part-3" },
            { label: "Part 4: Local Dev", link: "/tutorial/part-4" },
            { label: "Part 5: CI/CD", link: "/tutorial/part-5" },
            {
              label: "Cloudflare",
              collapsed: true,
              items: autogenerate("tutorial/cloudflare"),
            },
            {
              label: "AWS",
              collapsed: true,
              items: autogenerate("tutorial/aws"),
            },
          ],
        },
        {
          label: "Concepts",
          items: autogenerate("concepts"),
        },
        {
          label: "Guides",
          items: autogenerate("guides"),
        },
        providersSidebarEntry(),
      ],
      // starlight-blog feeds this many posts into the sidebar's "Recent"
      // group, which `src/blog-sidebar.ts` re-buckets into Releases/Posts.
      // We want every post listed, so set it effectively unlimited.
      plugins: [starlightBlog({ recentPostCount: Number.MAX_SAFE_INTEGER })],
      routeMiddleware: ["./src/blog-sidebar.ts"],
    }),
    mdx(),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
