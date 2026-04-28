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
 * satori → resvg.
 */

import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";
import { Resvg } from "@resvg/resvg-js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { OgCard, type OgCardKind } from "../../brand/OgCard";

interface Entry {
  slug: string;
  title: string;
  description?: string;
  kind: OgCardKind;
  eyebrow?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Font loading. Satori needs TTF or WOFF; we use the .woff files shipped by
// @fontsource/* (woff2 is unsupported). Loaded once at module scope so a
// build that renders N pages only pays this cost once.
// ────────────────────────────────────────────────────────────────────────────

const fontsRoot = (pkg: string) =>
  path.dirname(fileURLToPath(import.meta.resolve(`${pkg}/package.json`)));

async function readFont(pkg: string, filename: string): Promise<Buffer> {
  const file = path.join(fontsRoot(pkg), "files", filename);
  return fs.readFile(file);
}

const fontsPromise = (async () => {
  const [
    interRegular,
    interMedium,
    serifRegular,
    serifItalic,
    serifMedium,
    serifMediumItalic,
    monoRegular,
    monoMedium,
    caveatBold,
  ] = await Promise.all([
    readFont("@fontsource/inter", "inter-latin-400-normal.woff"),
    readFont("@fontsource/inter", "inter-latin-500-normal.woff"),
    readFont("@fontsource/source-serif-4", "source-serif-4-latin-400-normal.woff"),
    readFont("@fontsource/source-serif-4", "source-serif-4-latin-400-italic.woff"),
    readFont("@fontsource/source-serif-4", "source-serif-4-latin-500-normal.woff"),
    readFont("@fontsource/source-serif-4", "source-serif-4-latin-500-italic.woff"),
    readFont("@fontsource/jetbrains-mono", "jetbrains-mono-latin-400-normal.woff"),
    readFont("@fontsource/jetbrains-mono", "jetbrains-mono-latin-500-normal.woff"),
    readFont("@fontsource/caveat", "caveat-latin-600-normal.woff"),
  ]);
  return [
    { name: "Inter", data: interRegular, weight: 400, style: "normal" },
    { name: "Inter", data: interMedium, weight: 500, style: "normal" },
    { name: "Source Serif 4", data: serifRegular, weight: 400, style: "normal" },
    { name: "Source Serif 4", data: serifItalic, weight: 400, style: "italic" },
    { name: "Source Serif 4", data: serifMedium, weight: 500, style: "normal" },
    { name: "Source Serif 4", data: serifMediumItalic, weight: 500, style: "italic" },
    { name: "JetBrains Mono", data: monoRegular, weight: 400, style: "normal" },
    { name: "JetBrains Mono", data: monoMedium, weight: 500, style: "normal" },
    { name: "Caveat", data: caveatBold, weight: 600, style: "normal" },
  ] as const;
})();

// ────────────────────────────────────────────────────────────────────────────
// Page enumeration
// ────────────────────────────────────────────────────────────────────────────

/**
 * Fallbacks for the marketing pages — these aren't in a content collection
 * so we hand-curate their OG metadata. Keys are URL-style slugs (e.g.
 * `index` for `/`).
 */
const MARKETING_PAGES: Record<string, Omit<Entry, "slug" | "kind">> = {
  index: {
    title: "alchemy — zero → production",
    description:
      "TypeScript IaC on Effect. Stand up your whole cloud in one program, type-check the IAM, hot-reload it locally, run tests against the real cloud, preview every PR.",
    eyebrow: "alchemy · zero to production",
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
  const docs = await getCollection("docs");
  const docPaths = docs.map((entry) => {
    const slug = (entry as { slug?: string; id?: string }).slug ?? entry.id;
    const meta = classifyDoc(slug);
    const data = entry.data as { title?: string; description?: string };
    return {
      params: { slug },
      props: {
        slug,
        title: data.title ?? slug,
        description: data.description,
        kind: meta.kind,
        eyebrow: meta.eyebrow,
      } satisfies Entry,
    };
  });

  const marketingPaths = Object.entries(MARKETING_PAGES).map(([slug, meta]) => ({
    params: { slug },
    props: {
      slug,
      title: meta.title,
      description: meta.description,
      kind: "marketing" as const,
      eyebrow: meta.eyebrow,
    } satisfies Entry,
  }));

  return [...marketingPaths, ...docPaths];
};

export const GET: APIRoute = async ({ props }) => {
  const { title, description, kind, eyebrow } = props as Entry;
  const fonts = await fontsPromise;

  const element = OgCard({ title, description, eyebrow, kind });

  const svg = await satori(element, {
    width: 1200,
    height: 630,
    fonts: fonts as any,
  });

  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
  })
    .render()
    .asPng();

  return new Response(png, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
};
