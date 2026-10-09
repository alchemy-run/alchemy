import type { WorkerEnv } from "../alchemy.run.ts";
import {
  SEARCH_PROVIDERS,
  searchFacets,
  stripSiteTitle,
  toSnippet,
  type SearchHit,
  type SearchResponse,
  type SearchSection,
} from "./docs-search.ts";

// Minimal runtime shapes — the website doesn't pull in
// `@cloudflare/workers-types` (see the HTMLRewriter note in worker.ts).
export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}
declare const caches: {
  default: {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
  };
};
interface DocsSearchBinding {
  search(request: {
    query: string;
    ai_search_options?: {
      retrieval?: {
        max_num_results?: number;
        filters?: Record<string, unknown>;
      };
    };
  }): Promise<{
    chunks: Array<{
      text: string;
      score: number;
      item: { key: string; metadata?: Record<string, unknown> };
    }>;
  }>;
}

/** Only production owns the AI Search instance (see alchemy.run.ts). */
type SearchEnv = WorkerEnv & { DOCS_SEARCH?: DocsSearchBinding };

const MAX_QUERY = 200;
const MAX_HITS = 12;
const CACHE_SECONDS = 300;

/**
 * `GET /api/search?q=<query>&provider=<tab label>` → {@link SearchResponse}.
 *
 * Production queries its AI Search binding. Every other stage (main, PR
 * previews, personal stages) has no instance of its own and proxies to
 * production, so previews search the live docs instead of each paying to
 * crawl and index a copy. Responses are edge-cached for five minutes per
 * (query, provider) to keep repeat queries off the metered search API.
 */
export const handleSearch = async (
  request: Request,
  env: SearchEnv,
  ctx: ExecutionContext,
  canonicalOrigin: string,
): Promise<Response> => {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY);
  const providerParam = url.searchParams.get("provider") ?? "";
  const provider = SEARCH_PROVIDERS.includes(providerParam) ? providerParam : undefined;

  if (query.length < 2) {
    return json({ query, provider, hits: [] } satisfies SearchResponse, 0);
  }

  const search = env.DOCS_SEARCH;
  if (search === undefined) {
    if (url.origin === canonicalOrigin) {
      return new Response("Search unavailable", { status: 503 });
    }
    return fetch(`${canonicalOrigin}/api/search${url.search}`, {
      headers: { accept: "application/json" },
    });
  }

  const cacheKey = new Request(
    `${canonicalOrigin}/api/search?${new URLSearchParams({
      q: query.toLowerCase(),
      provider: provider ?? "",
    })}`,
  );
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  let result: Awaited<ReturnType<DocsSearchBinding["search"]>>;
  try {
    result = await search.search({
      query,
      ai_search_options: {
        retrieval: {
          max_num_results: 30,
          filters: provider ? { provider } : undefined,
        },
      },
    });
  } catch (error) {
    console.error("docs search failed", error);
    return new Response("Search failed", { status: 502 });
  }

  const res = json(
    { query, provider, hits: toHits(result.chunks) } satisfies SearchResponse,
    CACHE_SECONDS,
  );
  ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
};

/** Chunks → one hit per page, ordered by each page's best chunk. */
const toHits = (chunks: Awaited<ReturnType<DocsSearchBinding["search"]>>["chunks"]) => {
  const pages = new Map<string, SearchHit & { score: number }>();
  for (const chunk of chunks) {
    const pathname = toPathname(chunk.item.key);
    if (pathname === undefined) continue;
    const existing = pages.get(pathname);
    if (existing && existing.score >= chunk.score) continue;
    const metadata = chunk.item.metadata ?? {};
    const facets = searchFacets(pathname);
    pages.set(pathname, {
      url: pathname,
      title: stripSiteTitle(str(metadata.title) ?? titleFromPath(pathname)),
      provider: str(metadata.provider) ?? facets.provider,
      section: (str(metadata.section) as SearchSection | undefined) ?? facets.section,
      snippet: toSnippet(chunk.text),
      score: chunk.score,
    });
  }
  return [...pages.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HITS)
    .map(({ score: _, ...hit }) => hit);
};

/** Crawled item keys are page URLs; keep just the path (with trailing slash). */
const toPathname = (key: string): string | undefined => {
  try {
    const { pathname } = new URL(/^https?:\/\//.test(key) ? key : `https://${key}`);
    return pathname.endsWith("/") ? pathname : `${pathname}/`;
  } catch {
    return undefined;
  }
};

const titleFromPath = (pathname: string) =>
  (pathname.split("/").filter(Boolean).at(-1) ?? "Alchemy")
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

const str = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

const json = (body: SearchResponse, maxAge: number) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
      "x-robots-tag": "noindex",
    },
  });
