import { searchFacets, type SearchSection } from "../src/docs-search.ts";

/** One searchable unit: a page's intro, or an h2/h3 and the body under it. */
export interface DocSection {
  /** Page path with a trailing slash, e.g. `/cloudflare/compute/workers/`. */
  path: string;
  /** Heading id (`call-another-worker`), or `""` for the page intro. */
  anchor: string;
  title: string;
  heading: string | undefined;
  body: string;
  provider: string;
  section: SearchSection;
}

/** Pages that are never search results. */
const EXCLUDE = [
  /^\/404\/$/,
  /^\/auth\//,
  /^\/og\//,
  /^\/blog\/\d+\/$/,
  /^\/blog\/(tags|authors)\//,
];

const HEADING = /<h([23]) id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;

/**
 * One HTML tag, quote-aware: Expressive Code's copy button carries the raw
 * snippet in `data-code="…"`, whose `>` characters end a naive `<[^>]+>`.
 */
const TAG = String.raw`<\/?[a-zA-Z](?:[^"'>]|"[^"]*"|'[^']*')*>`;

/**
 * Split a rendered Starlight page into sections. The article body is
 * `.sl-markdown-content` (everything before the page footer); every h2/h3
 * carries the `id` its anchor links to, so each section deep-links exactly.
 * Marketing pages and redirect stubs have no article body and yield nothing.
 */
export const extractSections = (path: string, html: string): DocSection[] => {
  if (EXCLUDE.some((re) => re.test(path))) return [];
  if (/<meta\s+http-equiv="refresh"/i.test(html)) return [];
  const start = html.indexOf('<div class="sl-markdown-content">');
  if (start < 0) return [];
  const end = html.indexOf("<footer", start);
  const content = html.slice(start, end < 0 ? undefined : end);

  const title = htmlToText(html.match(/<h1 id="_top"[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "");
  const { provider, section } = searchFacets(path);
  const base = { path, title, provider, section };

  const sections: DocSection[] = [];
  let anchor = "";
  let heading: string | undefined;
  let from = 0;
  const flush = (to: number) => {
    const body = htmlToText(content.slice(from, to));
    if (body || heading) sections.push({ ...base, anchor, heading, body });
  };
  for (const match of content.matchAll(HEADING)) {
    flush(match.index);
    anchor = match[2]!;
    heading = htmlToText(match[3]!);
    from = match.index + match[0].length;
  }
  flush(content.length);
  return sections;
};

/** Rendered HTML → plain text, keeping line breaks between blocks and code lines. */
export const htmlToText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<(script|style|svg|template)\b[\s\S]*?<\/\1>/g, " ")
      .replace(
        new RegExp(String.raw`<button\b(?:[^"'>]|"[^"]*"|'[^']*')*>[\s\S]*?<\/button>`, "g"),
        " ",
      )
      // Heading anchor links' screen-reader text ("Section titled …").
      .replace(/<span class="sr-only"[^>]*>[\s\S]*?<\/span>/g, " ")
      .replace(/<(br|\/p|\/li|\/h\d|\/pre|\/tr|\/div|\/figcaption)\b[^>]*>/g, "\n")
      .replace(new RegExp(TAG, "g"), ""),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] === "#") {
      const point =
        code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(point) ? String.fromCodePoint(point) : entity;
    }
    return ENTITIES[code.toLowerCase()] ?? entity;
  });
