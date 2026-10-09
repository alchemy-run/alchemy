/**
 * Docs search, shared by the page `<head>` (facet meta tags), the Worker's
 * `/api/search` route, and the search dialog.
 *
 * Each page's sections are indexed at deploy time with its provider facet
 * (see search/index.ts), so a query can be filtered by provider; Pagefind
 * (the fallback index) reads the same facet from `<meta name="provider">`.
 */
import { activeTab, DOCS_TABS } from "./docs-tabs";

/**
 * Workers AI model that embeds docs sections at deploy time and search input
 * at request time. Chosen on the docs eval set: bge-base beat qwen3-0.6b and
 * bge-m3 on ranking, and answers in ~0.3s where qwen3 often took seconds.
 * Changing it re-embeds every section on the next deploy.
 */
export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBEDDING_DIMENSIONS = 768;

/**
 * FTS5 rowid of a section, derived from its Vectorize id (52 bits of the hex
 * id) so a vector match resolves to its row by primary key, not a table scan.
 */
export const sectionRowid = (id: string) => Number.parseInt(id.slice(0, 13), 16);

export type SearchSection = "guide" | "reference" | "blog";

export interface SearchFacets {
  /** Docs tab label the page belongs to (`AWS`, `Cloudflare`, `Core`, …). */
  provider: string;
  section: SearchSection;
}

/** Tabs that are not providers and get no filter chip of their own. */
const NON_PROVIDER_TABS = new Set(["Reference", "Blog", "Compare"]);

/** Filter chips, in tab-bar order. */
export const SEARCH_PROVIDERS: string[] = DOCS_TABS.filter(
  (tab) => !NON_PROVIDER_TABS.has(tab.label),
).map((tab) => tab.label);

export function searchFacets(pathname: string): SearchFacets {
  const tab = activeTab(pathname);
  const section: SearchSection = pathname.startsWith("/providers/")
    ? "reference"
    : pathname.startsWith("/blog")
      ? "blog"
      : "guide";
  return {
    provider: NON_PROVIDER_TABS.has(tab.label) && section !== "reference" ? "Core" : tab.label,
    section,
  };
}

/** One page in the search results. */
export interface SearchHit {
  /** Site-relative URL, so results link within the current deployment. */
  url: string;
  title: string;
  /** Heading of the matched section when {@link url} deep-links to it. */
  heading?: string;
  provider: string;
  section: SearchSection;
  /** Plain-text excerpt (no markup). */
  snippet: string;
}

export interface SearchResponse {
  query: string;
  provider: string | undefined;
  hits: SearchHit[];
}

/** Section text → one line of readable prose. */
export const toSnippet = (text: string, max = 220): string => {
  const plain = text.replace(/\s+/g, " ").trim();
  return plain.length > max ? `${plain.slice(0, max).replace(/\s+\S*$/, "")}…` : plain;
};
