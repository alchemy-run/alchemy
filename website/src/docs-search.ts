/**
 * Docs search, shared by the page `<head>` (facet meta tags), the Worker's
 * `/api/search` route, and the search dialog.
 *
 * Each page carries `<meta name="provider">` / `<meta name="section">`. The
 * AI Search crawler stores them as custom metadata, so a query can be
 * filtered by provider; Pagefind (the fallback index) reads the same
 * provider facet as a filter.
 */
import { activeTab, DOCS_TABS } from "./docs-tabs";

/**
 * AI Search instance name within the docs search namespace. The Worker binds
 * the namespace and resolves the instance by this name (see alchemy.run.ts).
 */
export const DOCS_SEARCH_INSTANCE = "docs";

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

/** Starlight titles render as `Page | Alchemy`. */
export const stripSiteTitle = (title: string) => title.replace(/\s*\|\s*Alchemy\s*$/, "");

/** Markdown-ish chunk text → one line of readable prose. */
export const toSnippet = (text: string, max = 220): string => {
  const plain = text
    .replace(/^---[\s\S]*?---/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#*_>`|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max).replace(/\s+\S*$/, "")}…` : plain;
};
