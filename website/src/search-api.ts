import type { WorkerEnv } from "../alchemy.run.ts";
import {
  chunkSection,
  DOCS_SEARCH_INSTANCE,
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
interface DocsSearchNamespaceBinding {
  get(instance: string): DocsSearchBinding;
}
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

/** Only production owns the AI Search instance and query log (see alchemy.run.ts). */
type SearchEnv = WorkerEnv & {
  DOCS_SEARCH?: DocsSearchNamespaceBinding;
  /** Axiom ingest endpoint for the query log dataset. */
  SEARCH_LOG_URL?: string;
  /** Ingest-only Axiom token for {@link SEARCH_LOG_URL}. */
  SEARCH_LOG_TOKEN?: string;
};

/** Set by a non-production stage when it proxies a search to production. */
const ORIGIN_HOST_HEADER = "x-docs-search-host";

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
 *
 * Every query that reaches production — cached or not, from any stage — is
 * logged to Axiom as one event (see {@link logQuery}).
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

  const namespace = env.DOCS_SEARCH;
  if (namespace === undefined) {
    if (url.origin === canonicalOrigin) {
      return new Response("Search unavailable", { status: 503 });
    }
    return fetch(`${canonicalOrigin}/api/search${url.search}`, {
      headers: {
        accept: "application/json",
        referer: request.headers.get("referer") ?? "",
        [ORIGIN_HOST_HEADER]: url.host,
      },
    });
  }

  const cacheKey = new Request(
    `${canonicalOrigin}/api/search?${new URLSearchParams({
      q: query.toLowerCase(),
      provider: provider ?? "",
    })}`,
  );
  const started = Date.now();
  const log = (fields: Pick<QueryEvent, "status" | "cached" | "hits">) =>
    logQuery(env, ctx, {
      query,
      provider: provider ?? "All",
      ...fields,
      latencyMs: Date.now() - started,
      page: pagePath(request.headers.get("referer")),
      host: request.headers.get(ORIGIN_HOST_HEADER) ?? url.host,
      country: (request as { cf?: { country?: string } }).cf?.country,
    });

  const cached = await caches.default.match(cacheKey);
  if (cached) {
    const { hits } = (await cached.clone().json()) as SearchResponse;
    log({ status: "ok", cached: true, hits });
    return cached;
  }

  let result: Awaited<ReturnType<DocsSearchBinding["search"]>>;
  try {
    result = await namespace.get(DOCS_SEARCH_INSTANCE).search({
      query,
      ai_search_options: {
        retrieval: {
          max_num_results: 50,
          filters: provider ? { provider } : undefined,
        },
      },
    });
  } catch (error) {
    console.error("docs search failed", error);
    log({ status: "error", cached: false, hits: [] });
    return new Response("Search failed", { status: 502 });
  }

  const hits = toHits(result.chunks, query);
  log({ status: "ok", cached: false, hits });
  const res = json({ query, provider, hits } satisfies SearchResponse, CACHE_SECONDS);
  ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
};

interface QueryEvent {
  query: string;
  /** Provider filter chip, `All` when unfiltered. */
  provider: string;
  status: "ok" | "error";
  /** Served from the edge cache rather than AI Search. */
  cached: boolean;
  hits: SearchHit[];
  latencyMs: number;
  /** Docs page the search was made from (Referer path). */
  page: string | undefined;
  /** Deployment the search was made on (`alchemy.run`, a preview, …). */
  host: string;
  country: string | undefined;
}

/**
 * Ship one query event to Axiom without delaying or altering the response:
 * the ingest runs in `waitUntil` and its failures are swallowed. The dialog
 * searches as you type (debounced), so a single search session can log a
 * few prefixes of the final query.
 */
const logQuery = (env: SearchEnv, ctx: ExecutionContext, { hits, ...event }: QueryEvent) => {
  if (!env.SEARCH_LOG_URL || !env.SEARCH_LOG_TOKEN) return;
  const body = JSON.stringify({
    _time: new Date().toISOString(),
    ...event,
    hitCount: hits.length,
    topUrls: hits.slice(0, 5).map((hit) => hit.url),
  });
  ctx.waitUntil(
    fetch(env.SEARCH_LOG_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SEARCH_LOG_TOKEN}`,
        "content-type": "application/x-ndjson",
      },
      body,
    })
      .then((res) => {
        if (!res.ok) console.error(`search log ingest failed: ${res.status}`);
      })
      .catch((error) => console.error("search log ingest failed", error)),
  );
};

const pagePath = (referer: string | null) => {
  if (!referer) return undefined;
  try {
    return new URL(referer).pathname;
  } catch {
    return undefined;
  }
};

type Chunk = Awaited<ReturnType<DocsSearchBinding["search"]>>["chunks"][number];

/** Weight of a query-term match in the page title or a matched heading. */
const TITLE_BONUS = 0.6;

/**
 * Chunks → one hit per page. A page scores the sum of its top three chunk
 * scores plus {@link TITLE_BONUS} × the share of query terms found in its
 * title or a matched section heading. Ranking by a page's single best chunk
 * let long pages that merely mention a term outrank the page about it; on
 * the docs eval set this lifts MRR from 0.71 to 0.77.
 */
const toHits = (chunks: Chunk[], query: string): SearchHit[] => {
  const pages = new Map<string, Chunk[]>();
  for (const chunk of chunks) {
    const pathname = toPathname(chunk.item.key);
    if (pathname === undefined) continue;
    pages.set(pathname, [...(pages.get(pathname) ?? []), chunk]);
  }
  const terms = queryTerms(query);
  return [...pages]
    .map(([pathname, pageChunks]) => {
      const sorted = pageChunks.toSorted((a, b) => b.score - a.score);
      const best = sorted[0]!;
      const metadata = best.item.metadata ?? {};
      const facets = searchFacets(pathname);
      const title = stripSiteTitle(str(metadata.title) ?? titleFromPath(pathname));
      const headings = sorted.flatMap((chunk) => chunkSection(chunk.text)?.heading ?? []);
      // Deep-link to the best chunk's section when it starts at a heading.
      const section = chunkSection(best.text);
      const score =
        sorted.slice(0, 3).reduce((sum, chunk) => sum + chunk.score, 0) +
        TITLE_BONUS * Math.max(...[title, ...headings].map((text) => termOverlap(terms, text)));
      return {
        score,
        hit: {
          url: section ? `${pathname}#${section.anchor}` : pathname,
          title,
          heading: section?.heading,
          provider: str(metadata.provider) ?? facets.provider,
          section: (str(metadata.section) as SearchSection | undefined) ?? facets.section,
          snippet: toSnippet(best.text),
        } satisfies SearchHit,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HITS)
    .map(({ hit }) => hit);
};

const STOPWORDS = new Set(
  "a an and are as at be by do does for from how i in is it my of on or the to with".split(" "),
);
/** Naive plural folding, enough for `workers` ≈ `worker`. */
const stem = (word: string) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const queryTerms = (query: string) =>
  words(query)
    .filter((w) => !STOPWORDS.has(w))
    .map(stem);

/** Share of `terms` that appear in `text`. */
const termOverlap = (terms: string[], text: string) => {
  if (terms.length === 0) return 0;
  const present = new Set(words(text).map(stem));
  return terms.filter((term) => present.has(term)).length / terms.length;
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
