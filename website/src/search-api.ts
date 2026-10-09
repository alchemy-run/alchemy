import {
  EMBEDDING_MODEL,
  SEARCH_PROVIDERS,
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
interface WorkersAI {
  run(model: string, input: { queries: string[] }): Promise<{ data: number[][] }>;
}
interface VectorIndex {
  query(
    vector: number[],
    options: { topK: number; filter?: Record<string, string> },
  ): Promise<{ matches: Array<{ id: string; score: number }> }>;
}
interface Database {
  prepare(sql: string): {
    bind(...values: unknown[]): { all<T>(): Promise<{ results: T[] }> };
  };
}

/** Only production binds the search index and query log (see alchemy.run.ts). */
interface SearchEnv {
  AI?: WorkersAI;
  /** Section embeddings (search/index.ts). */
  DOCS_VECTORS?: VectorIndex;
  /** Section text in an FTS5 table (search/migrations). */
  DOCS_TEXT?: Database;
  /** Axiom ingest endpoint for the query log dataset. */
  SEARCH_LOG_URL?: string;
  /** Ingest-only Axiom token for {@link SEARCH_LOG_URL}. */
  SEARCH_LOG_TOKEN?: string;
}

/** Set by a non-production stage when it proxies a search to production. */
const ORIGIN_HOST_HEADER = "x-docs-search-host";

const MAX_QUERY = 200;
const MAX_HITS = 12;
const CACHE_SECONDS = 300;

/**
 * `GET /api/search?q=<query>&provider=<tab label>` → {@link SearchResponse}.
 *
 * Production searches its own index: docs sections embedded into Vectorize
 * and stored in a D1 FTS5 table at deploy time (search/index.ts). Every
 * other stage (main, PR previews, personal stages) proxies to production
 * rather than indexing its own copy. Responses are edge-cached for five
 * minutes per (query, provider).
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

  const { AI, DOCS_VECTORS, DOCS_TEXT } = env;
  if (!AI || !DOCS_VECTORS || !DOCS_TEXT) {
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

  let sections: ScoredSection[];
  try {
    sections = await retrieve({ AI, DOCS_VECTORS, DOCS_TEXT }, query, provider);
  } catch (error) {
    console.error("docs search failed", error);
    log({ status: "error", cached: false, hits: [] });
    return new Response("Search failed", { status: 502 });
  }

  const hits = toHits(sections, query);
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
  /** Served from the edge cache rather than the index. */
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

interface SectionRow {
  id: string;
  path: string;
  anchor: string;
  title: string;
  heading: string;
  provider: string;
  section: SearchSection;
  snippet: string;
}
interface ScoredSection extends SectionRow {
  /** Fused rank score, normalized so the best section scores 1. */
  score: number;
}

/** Candidates taken from each retriever (Vectorize's topK max). */
const CANDIDATES = 100;
/** Reciprocal-rank-fusion damping. */
const RRF_K = 60;
const COLUMNS = "id, path, anchor, title, heading, provider, section";

/**
 * Hybrid retrieval over docs sections: semantic (embed the query, nearest
 * neighbours in Vectorize) and keyword (FTS5 BM25, title and heading
 * weighted above body), fused by reciprocal rank.
 */
const retrieve = async (
  env: Required<Pick<SearchEnv, "AI" | "DOCS_VECTORS" | "DOCS_TEXT">>,
  query: string,
  provider: string | undefined,
): Promise<ScoredSection[]> => {
  const match = words(query)
    .filter((word) => !STOPWORDS.has(word))
    .map((word) => `"${word}"`)
    .join(" OR ");
  const [semantic, keyword] = await Promise.all([
    env.AI.run(EMBEDDING_MODEL, { queries: [query] })
      .then(({ data }) =>
        env.DOCS_VECTORS.query(data[0]!, {
          topK: CANDIDATES,
          filter: provider ? { provider } : undefined,
        }),
      )
      .then(({ matches }) => matches.map((match) => match.id)),
    match
      ? env.DOCS_TEXT.prepare(
          `SELECT ${COLUMNS}, snippet(sections, 8, '', '', '…', 40) AS snippet FROM sections
             WHERE sections MATCH ?1 AND (?2 IS NULL OR provider = ?2)
             ORDER BY bm25(sections, 0, 0, 0, 0, 0, 0, 10.0, 5.0, 1.0) LIMIT ?3`,
        )
          .bind(match, provider ?? null, CANDIDATES)
          .all<SectionRow>()
          .then(({ results }) => results)
      : Promise.resolve([]),
  ]);

  const rows = new Map(keyword.map((row) => [row.id, row]));
  const missing = semantic.filter((id) => !rows.has(id));
  if (missing.length > 0) {
    const { results } = await env.DOCS_TEXT.prepare(
      `SELECT ${COLUMNS}, substr(body, 1, 600) AS snippet FROM sections
         WHERE id IN (${missing.map(() => "?").join(", ")})`,
    )
      .bind(...missing)
      .all<SectionRow>();
    for (const row of results) rows.set(row.id, row);
  }

  const fused = new Map<string, number>();
  for (const ids of [semantic, keyword.map((row) => row.id)]) {
    ids.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  const best = Math.max(0, ...fused.values());
  return [...fused].flatMap(([id, score]) => {
    const row = rows.get(id);
    return row ? [{ ...row, score: score / best }] : [];
  });
};

/** Weight of a query-term match in the page title or a matched heading. */
const TITLE_BONUS = 1.0;

/**
 * Sections → one hit per page. A page scores the sum of its top three
 * section scores plus {@link TITLE_BONUS} × the share of query terms found
 * in its title or a matched section heading, so a page about the query
 * outranks a long page that merely mentions it. The hit deep-links to the
 * page's best section.
 */
const toHits = (sections: ScoredSection[], query: string): SearchHit[] => {
  const pages = new Map<string, ScoredSection[]>();
  for (const section of sections) {
    pages.set(section.path, [...(pages.get(section.path) ?? []), section]);
  }
  const terms = queryTerms(query);
  return [...pages.values()]
    .map((pageSections) => {
      const sorted = pageSections.toSorted((a, b) => b.score - a.score);
      const best = sorted[0]!;
      const headings = sorted.map((section) => section.heading).filter(Boolean);
      const score =
        sorted.slice(0, 3).reduce((sum, section) => sum + section.score, 0) +
        TITLE_BONUS *
          Math.max(...[best.title, ...headings].map((text) => termOverlap(terms, text)));
      return {
        score,
        hit: {
          url: best.anchor ? `${best.path}#${best.anchor}` : best.path,
          title: best.title,
          heading: best.heading || undefined,
          provider: best.provider,
          section: best.section,
          snippet: toSnippet(best.snippet),
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

const json = (body: SearchResponse, maxAge: number) =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": maxAge > 0 ? `public, max-age=${maxAge}` : "no-store",
      "x-robots-tag": "noindex",
    },
  });
