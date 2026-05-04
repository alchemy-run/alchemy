/**
 * Generates `public/llms.txt` — a navigation index of every docs page,
 * grouped by section, with title + description pulled from each page's
 * frontmatter.
 *
 * Run with: `bun scripts/generate-llms-txt.ts`
 *
 * Section ordering, headings, and prose intros are configured here.
 * Page metadata (title, description) comes from the source frontmatter,
 * so editing a page's frontmatter is enough to update llms.txt.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(here, "../src/content/docs");
const outFile = path.resolve(here, "../public/llms.txt");
const siteUrl = "https://v2.alchemy.run";

interface Page {
  /** URL path, e.g. "/concepts/binding" */
  href: string;
  /** Path relative to docs dir without extension, e.g. "concepts/binding" */
  slug: string;
  title: string;
  description: string;
}

interface Section {
  /** H2 heading */
  heading: string;
  /** Optional prose paragraph after the heading. */
  intro?: string;
  /**
   * Pages to include. Either a list of explicit slugs (relative to docs dir,
   * no extension) in the desired order, or a directory to enumerate
   * alphabetically.
   */
  pages: { slugs: string[] } | { directory: string; exclude?: string[] };
}

const SECTIONS: Section[] = [
  {
    heading: "Start here",
    pages: { slugs: ["what-is-alchemy", "getting-started"] },
  },
  {
    heading: "Tutorial — main path (Cloudflare)",
    intro:
      "A linear five-part walkthrough from zero to a tested, locally-developed, CI-deployed Cloudflare project. Each part builds on the previous one.",
    pages: {
      slugs: [
        "tutorial/part-1",
        "tutorial/part-2",
        "tutorial/part-3",
        "tutorial/part-4",
        "tutorial/part-5",
      ],
    },
  },
  {
    heading: "Tutorial — Cloudflare add-ons",
    intro:
      "Standalone tutorials that extend the main tutorial's Worker with a specific Cloudflare feature. Pick the ones that match your use case.",
    pages: {
      slugs: [
        "tutorial/cloudflare/durable-objects",
        "tutorial/cloudflare/hibernatable-websockets",
        "tutorial/cloudflare/containers",
        "tutorial/cloudflare/workflows",
        "tutorial/cloudflare/vite-spa",
        "tutorial/cloudflare/ai-gateway",
      ],
    },
  },
  {
    heading: "Tutorial — AWS",
    intro:
      "End-to-end AWS tutorials. Read the Lambda page first; the others bind storage and event sources to that Lambda.",
    pages: {
      slugs: [
        "tutorial/aws/lambda",
        "tutorial/aws/s3",
        "tutorial/aws/s3-events",
        "tutorial/aws/sqs",
        "tutorial/aws/kinesis",
        "tutorial/aws/dynamodb",
        "tutorial/aws/dynamodb-streams",
      ],
    },
  },
  {
    heading: "Concepts — the mental model",
    intro:
      "Reference pages explaining what each primitive means and how they fit together. Read these when something in a tutorial feels magical, or before designing a new Stack.",
    pages: {
      slugs: [
        "concepts/resource",
        "concepts/provider",
        "concepts/resource-lifecycle",
        "concepts/stack",
        "concepts/stages",
        "concepts/phases",
        "concepts/platform",
        "concepts/binding",
        "concepts/outputs",
        "concepts/layers",
        "concepts/state-store",
        "concepts/profiles",
        "concepts/local-development",
        "concepts/observability",
        "concepts/testing",
      ],
    },
  },
  {
    heading: "Guides — task-oriented",
    intro:
      "Standalone how-to pages. Each solves a specific problem; read in any order.",
    pages: { directory: "guides" },
  },
  {
    heading: "Blog",
    pages: { directory: "blog" },
  },
];

const PROVIDERS_SECTION = `## Providers — auto-generated API reference

Per-resource API pages live under \`${siteUrl}/providers/{Cloud}/{Resource}\` (e.g. \`/providers/AWS/Bucket\`, \`/providers/Cloudflare/Worker\`). They are generated from JSDoc on the source \`.ts\` files via \`bun generate:api-reference\` and are not checked into git, so this index does not enumerate them. Each page documents:

- The resource's input properties (props) with types, defaults, and constraints.
- The resource's output attributes.
- Quick Reference and Examples sections derived from \`@section\` / \`@example\` JSDoc tags.

To find a specific resource, browse the Providers section in the sidebar at ${siteUrl}, or read the source JSDoc at \`packages/alchemy/src/{Cloud}/{Service}/{Resource}.ts\` in [the repository](https://github.com/alchemy-run/alchemy-effect).`;

const HEADER = `# Alchemy

> Alchemy Effect is an Infrastructure-as-Effects (IaE) framework that combines cloud infrastructure and application logic into a single, type-safe program powered by [Effect](https://effect.website). Resources are declared as Effects; bindings wire IAM, env vars, and typed SDKs in one call; deploys and runtime share the same code.

This file is a navigation index for the documentation site at ${siteUrl}. Every page under \`/src/content/docs/\` is listed below with its URL and a one-line summary, so an agent can pick the right page in one hop.`;

function parseFrontmatter(source: string): Record<string, string> {
  if (!source.startsWith("---")) return {};
  const end = source.indexOf("\n---", 3);
  if (end === -1) return {};
  const block = source.slice(3, end);
  const out: Record<string, string> = {};
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

async function loadPage(slug: string): Promise<Page> {
  const candidates = [`${slug}.mdx`, `${slug}.md`];
  for (const rel of candidates) {
    const full = path.join(docsDir, rel);
    try {
      const source = await readFile(full, "utf8");
      const fm = parseFrontmatter(source);
      const title = fm.title;
      const description = fm.description ?? fm.excerpt ?? "";
      if (!title) {
        throw new Error(`Missing title in frontmatter: ${rel}`);
      }
      return {
        href: `/${slug}`,
        slug,
        title,
        description,
      };
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
  throw new Error(`Page not found: ${slug} (looked for .mdx and .md)`);
}

async function listSlugs(
  directory: string,
  exclude: string[] = [],
): Promise<string[]> {
  const dir = path.join(docsDir, directory);
  const entries = await readdir(dir, { withFileTypes: true });
  const slugs: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    if (ext !== ".md" && ext !== ".mdx") continue;
    const slug = `${directory}/${entry.name.slice(0, -ext.length)}`;
    if (exclude.includes(slug)) continue;
    slugs.push(slug);
  }
  slugs.sort();
  return slugs;
}

function renderPage(page: Page): string {
  const url = `${siteUrl}${page.href}`;
  const desc = page.description ? ` — ${page.description}` : "";
  return `- [${page.title}](${url})${desc}`;
}

async function main() {
  const parts: string[] = [HEADER];

  for (const section of SECTIONS) {
    const slugs =
      "slugs" in section.pages
        ? section.pages.slugs
        : await listSlugs(section.pages.directory, section.pages.exclude);
    const pages = await Promise.all(slugs.map(loadPage));

    parts.push(`## ${section.heading}`);
    if (section.intro) parts.push(section.intro);
    parts.push(pages.map(renderPage).join("\n"));
  }

  parts.push(PROVIDERS_SECTION);

  const body = parts.join("\n\n") + "\n";
  await writeFile(outFile, body, "utf8");
  console.log(`Wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
