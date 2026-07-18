/**
 * Static Open Graph image endpoint. During `astro build` Astro invokes this
 * for every entry returned by `getStaticPaths`, writing a PNG into
 * `dist/og/<slug>.png`. Pages reference these via `<meta property="og:image">`
 * in their layout/head.
 *
 * - Marketing pages (top-level `src/pages/*.{astro,mdx}`) → /og/<page>.png
 *   (the homepage is keyed as `index`).
 * - Starlight docs (`getCollection("docs")`) → /og/<entry.slug>.png.
 *
 * The card itself lives in `src/brand/OgCard.tsx` and is rendered via
 * satori → resvg. Fonts are the same families used on the website
 * (`tokens.css`), loaded as full unsubsetted variable TTFs from
 * `website/assets/fonts/` so satori has complete Unicode coverage —
 * arrows, em-dashes, fancy quotes, etc. all render verbatim.
 */

import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { OgCard, type OgCardKind, type TitlePart } from "../../brand/OgCard";

interface Entry {
  slug: string;
  title: string | TitlePart[];
  description?: string;
  kind: OgCardKind;
  eyebrow?: string;
  /** ISO date string — rendered in the footer for blog cards. */
  date?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Font loading. The website's font stack for the hero is
//   "Source Serif 4", "Source Serif Pro", Georgia, "Times New Roman", serif
// We mirror that here with Source Serif 4 as the primary face (regular,
// italic, semibold, semibold-italic), plus JetBrains Mono for the eyebrow
// label and Caveat for the hand-drawn URL stamp. All loaded as static TTFs
// from `website/assets/fonts/` (populated by `scripts/download-fonts.ts`),
// which carry the full Unicode glyph table — arrows, em-dashes, etc. — so
// the source content renders verbatim with no glyph workarounds.
// ────────────────────────────────────────────────────────────────────────────

const buildFontsDir = fileURLToPath(
  new URL("../../../assets/fonts/", import.meta.url),
);
const publicFontsDir = fileURLToPath(
  new URL("../../../public/fonts/", import.meta.url),
);

/**
 * Font metadata only — the actual files are read by the render workers
 * (scripts/og-worker.mjs), once per worker. Family/weight/style choices are
 * documented in the git history of this file; the short version: Source
 * Serif 4 Display mirrors the website hero, Tinos supplies the TNR-style
 * arrow glyph, JetBrains Mono the eyebrow, Caveat the URL stamp.
 */
const FONTS = [
  {
    name: "Source Serif 4",
    file: "SourceSerif4-Regular.ttf",
    weight: 400,
    style: "normal",
  },
  {
    name: "Source Serif 4",
    file: "SourceSerif4-It.ttf",
    weight: 400,
    style: "italic",
  },
  {
    name: "Source Serif 4 Display",
    file: "SourceSerif4Display-Light.ttf",
    weight: 300,
    style: "normal",
  },
  {
    name: "Source Serif 4 Display",
    file: "SourceSerif4Display-LightIt.ttf",
    weight: 300,
    style: "italic",
  },
  {
    name: "Source Serif 4 Display",
    file: "SourceSerif4Display-Regular.ttf",
    weight: 400,
    style: "normal",
  },
  {
    name: "Source Serif 4 Display",
    file: "SourceSerif4Display-It.ttf",
    weight: 400,
    style: "italic",
  },
  {
    name: "Source Serif 4 Display",
    file: "SourceSerif4Display-Semibold.ttf",
    weight: 600,
    style: "normal",
  },
  {
    name: "Source Serif 4 Display",
    file: "SourceSerif4Display-SemiboldIt.ttf",
    weight: 600,
    style: "italic",
  },
  {
    name: "Tinos",
    file: "Tinos-Regular.ttf",
    weight: 400,
    style: "normal",
    public: true,
  },
  {
    name: "JetBrains Mono",
    file: "JetBrainsMono-Regular.ttf",
    weight: 400,
    style: "normal",
  },
  { name: "Caveat", file: "Caveat-Regular.ttf", weight: 400, style: "normal" },
] as const;

const workerFonts = FONTS.map(({ file, public: pub, ...font }) => ({
  ...font,
  path: path.join(pub ? publicFontsDir : buildFontsDir, file),
}));

// ────────────────────────────────────────────────────────────────────────────
// Render pool + disk cache.
//
// Rendering a satori→resvg PNG per page is (was) the single most expensive
// build step: ~130ms × ~4k pages ≈ 9 minutes, serially, on the build's main
// thread. Two fixes:
//
// 1. All renders run in a pool of worker threads (scripts/og-worker.mjs) —
//    the element tree is plain JSON, so the main thread just ships
//    `OgCard(props)` to a worker. The pool is pre-warmed from
//    `getStaticPaths`, so workers crunch OG images concurrently while the
//    main thread prerenders HTML pages.
//
// 2. Finished PNGs are cached in node_modules/.cache/alchemy-og keyed by a
//    hash of the element tree + font files, so warm rebuilds skip
//    rendering entirely. The tree hash covers everything visual (props AND
//    OgCard markup/styles); bump CACHE_VERSION when changing the renderer
//    setup itself (satori/resvg versions or render options).
// ────────────────────────────────────────────────────────────────────────────

const CACHE_VERSION = 1;
const cacheDir = path.resolve("node_modules/.cache/alchemy-og");

let fontFingerprintPromise: Promise<string> | undefined;
function getFontFingerprint() {
  return (fontFingerprintPromise ??= (async () => {
    const stats = await Promise.all(
      workerFonts.map(async (f) => {
        const s = await fs.stat(f.path);
        return `${path.basename(f.path)}:${s.size}`;
      }),
    );
    return createHash("sha256").update(stats.join("\n")).digest("hex");
  })());
}

class RenderPool {
  private workers: Worker[] = [];
  private pending = new Map<
    number,
    { resolve: (png: Buffer) => void; reject: (error: Error) => void }
  >();
  private nextId = 0;

  // ref() the workers only while renders are in flight. Permanently
  // unref'd workers let Node exit mid-build (an awaited postMessage reply
  // doesn't hold the event loop); permanently ref'd ones hang the build
  // at the end. Toggling on the in-flight count gives both properties.
  private setRef(on: boolean) {
    for (const w of this.workers) (on ? w.ref : w.unref).call(w);
  }

  constructor(size: number) {
    // Resolves to website/scripts/og-worker.mjs both from src/pages/og/
    // (dev) and from dist/.prerender/chunks/ (build) — same 3-level walk
    // the font dirs rely on.
    const workerPath = fileURLToPath(
      new URL("../../../scripts/og-worker.mjs", import.meta.url),
    );
    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerPath, {
        workerData: { fonts: workerFonts },
      });
      worker.on("message", ({ id, png, error }) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (this.pending.size === 0) this.setRef(false);
        if (error) entry.reject(new Error(error));
        else entry.resolve(Buffer.from(png));
      });
      worker.unref();
      this.workers.push(worker);
    }
  }

  render(tree: unknown): Promise<Buffer> {
    const id = this.nextId++;
    const worker = this.workers[id % this.workers.length];
    return new Promise((resolve, reject) => {
      if (this.pending.size === 0) this.setRef(true);
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, tree });
    });
  }
}

let pool: RenderPool | undefined;
function getPool() {
  return (pool ??= new RenderPool(
    Math.max(1, Math.min(os.availableParallelism() - 1, 12)),
  ));
}

/** Cache filenames referenced by the current build, for pruning. */
const usedCacheFiles = new Set<string>();

/** Render (or cache-read) one card; returns the PNG. */
async function renderCard(entry: Entry): Promise<Buffer> {
  const { title, description, kind, eyebrow, date } = entry;
  // OgCard is a pure function of its props; the element tree it returns is
  // plain data, so it both ships to the worker AND serves as the cache key
  // (it captures card markup/style changes, not just prop changes).
  const tree = OgCard({ title, description, eyebrow, kind, date });
  const json = JSON.stringify(tree);
  const key = createHash("sha256")
    .update(`v${CACHE_VERSION}\n${await getFontFingerprint()}\n${json}`)
    .digest("hex");
  const cacheFile = `${key}.png`;
  usedCacheFiles.add(cacheFile);
  const cachePath = path.join(cacheDir, cacheFile);
  try {
    return await fs.readFile(cachePath);
  } catch {
    // cache miss
  }
  const png = await getPool().render(JSON.parse(json));
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cachePath, png);
  return png;
}

/** slug → in-flight render, primed for every entry from getStaticPaths. */
const prewarmed = new Map<string, Promise<Buffer>>();

function prewarm(entries: Entry[]) {
  // `astro dev` also calls getStaticPaths — don't rasterize 4k cards on
  // dev-server startup. Dev GETs render on demand (and still use the
  // cache).
  if (import.meta.env.DEV) return;
  for (const entry of entries) {
    prewarmed.set(entry.slug, renderCard(entry));
  }
  // Surface failures per-route (each GET awaits its own slug), not as
  // unhandled rejections here. Once every render settles, prune cache
  // entries this build no longer references — deleted pages and edited
  // cards would otherwise accumulate forever (locally and in the CI
  // cache, which round-trips this directory between runs).
  void Promise.allSettled(prewarmed.values()).then(async () => {
    let names: string[];
    try {
      names = await fs.readdir(cacheDir);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((n) => n.endsWith(".png") && !usedCacheFiles.has(n))
        .map((n) => fs.rm(path.join(cacheDir, n), { force: true })),
    );
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Page enumeration
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fallbacks for the marketing pages — these aren't in a content collection
 * so we hand-curate their OG metadata. Keys are URL-style slugs (e.g.
 * `index` for `/`).
 */
const MARKETING_PAGES: Record<string, Omit<Entry, "slug" | "kind">> = {
  // Title parts mirror the homepage hero markup, which explicitly
  // italicizes "Zero" in the deep-moss accent — see index.mdx:
  //   <span style="color:var(--alc-accent-deep);font-style:italic;">Zero</span>
  //   {" "}&rarr; production.
  index: {
    title: [
      { text: "Zero", italic: true, accent: true },
      // Arrow rendered from Tinos (TNR-equivalent) so the OG mirrors
      // the website, where this glyph falls through the font stack to
      // Times New Roman. Non-breaking spaces flank it so the line
      // doesn't break around the arrow.
      { text: "\u00A0\u2192\u00A0", font: "tinos" },
      { text: "production." },
    ],
    description:
      "TypeScript IaC on Effect. Stand up your whole cloud in one program, type-check the IAM, hot-reload it locally, run tests against the real cloud, preview every PR.",
    eyebrow: "typescript · effect · infrastructure as code",
  },
};

function classifyDoc(slug: string): { kind: OgCardKind; eyebrow: string } {
  if (slug.startsWith("blog/"))
    return { kind: "blog", eyebrow: "blog · alchemy.run" };
  if (slug.startsWith("guides/"))
    return { kind: "doc", eyebrow: "guide · alchemy" };
  if (slug.startsWith("concepts/"))
    return { kind: "doc", eyebrow: "concept · alchemy" };
  if (slug.startsWith("tutorial/"))
    return { kind: "doc", eyebrow: "tutorial · alchemy" };
  if (slug.startsWith("providers/"))
    return { kind: "doc", eyebrow: "provider · alchemy" };
  if (slug.startsWith("compare/"))
    return { kind: "doc", eyebrow: "compare · alchemy" };
  return { kind: "doc", eyebrow: "alchemy · documentation" };
}

export const getStaticPaths: GetStaticPaths = async () => {
  // `DOCS_FAST=1` (the `docs:check` build target) skips OG image generation —
  // rendering a satori→resvg PNG per page is the second-most-expensive build
  // step and is irrelevant to link checking.
  if (process.env.DOCS_FAST) return [];

  const docs = await getCollection("docs");
  const docPaths = docs.map((entry: any) => {
    const slug = (entry as { slug?: string; id?: string }).slug ?? entry.id;
    const meta = classifyDoc(slug);
    const data = entry.data as {
      title?: string;
      description?: string;
      excerpt?: string;
      date?: string | Date;
    };
    return {
      params: { slug },
      props: {
        slug,
        title: data.title ?? slug,
        // Blog frontmatter uses `excerpt` (starlight-blog schema). Fall
        // back to it so the OG card has body copy to fill the layout.
        description: data.description ?? data.excerpt,
        kind: meta.kind,
        eyebrow: meta.eyebrow,
        date:
          data.date instanceof Date
            ? data.date.toISOString().slice(0, 10)
            : data.date,
      } satisfies Entry,
    };
  });

  const marketingPaths = Object.entries(MARKETING_PAGES).map(
    ([slug, meta]) => ({
      params: { slug },
      props: {
        slug,
        title: meta.title,
        description: meta.description,
        kind: "marketing" as const,
        eyebrow: meta.eyebrow,
      } satisfies Entry,
    }),
  );

  const paths = [...marketingPaths, ...docPaths];
  // Kick off every render now: workers rasterize OG cards in parallel
  // while Astro's main thread prerenders HTML pages. Each GET below just
  // awaits its slug's already-running (or already-cached) render.
  prewarm(paths.map((p) => p.props));
  return paths;
};

export const GET: APIRoute = async ({ props }) => {
  const entry = props as Entry;
  const png = await (prewarmed.get(entry.slug) ?? renderCard(entry));
  return new Response(png as any, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};
