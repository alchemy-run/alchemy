/**
 * The horizontal docs tab bar (bun.com-style primary navigation).
 *
 * Each tab owns a URL prefix and a sidebar: the tab bar renders in the docs
 * header (see `components/starlight/DocsTabs.astro`) and the route middleware
 * (`docs-tabs-sidebar.ts`) swaps in the sidebar group whose label matches the
 * active tab. The `label` here MUST match the top-level group label in
 * `astro.config.mjs`'s `sidebar` array.
 */
export interface DocsTab {
  label: string;
  href: string;
  /** URL path prefixes this tab owns (matched on segment boundaries). */
  prefixes: string[];
}

export const DOCS_TABS: DocsTab[] = [
  { label: "Docs", href: "/getting-started", prefixes: [] },
  { label: "Cloudflare", href: "/cloudflare", prefixes: ["/cloudflare"] },
  { label: "AWS", href: "/aws", prefixes: ["/aws"] },
  {
    label: "Integrations",
    href: "/integrations",
    prefixes: ["/integrations"],
  },
  { label: "Reference", href: "/providers", prefixes: ["/providers"] },
  { label: "Blog", href: "/blog", prefixes: ["/blog"] },
];

const matches = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/**
 * Resolve the active tab for a pathname. Docs (the platform tab) is the
 * fallback for every docs page that no cloud/reference/blog prefix claims
 * (what-is-alchemy, getting-started, concepts, guides).
 */
export function activeTab(pathname: string): DocsTab {
  const normalized = pathname.replace(/\/$/, "") || "/";
  for (const tab of DOCS_TABS) {
    if (tab.prefixes.some((p) => matches(normalized, p))) return tab;
  }
  return DOCS_TABS[0];
}
