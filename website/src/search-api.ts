import {
  EMBEDDING_MODEL,
  sectionRowid,
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
  run(model: string, input: { text: string[] }): Promise<{ data: number[][] }>;
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
  const log = (fields: Pick<QueryEvent, "status" | "cached" | "hits" | "timings">) =>
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

  const timings: Timings = {};
  let sections: ScoredSection[];
  try {
    sections = await retrieve({ AI, DOCS_VECTORS, DOCS_TEXT }, query, provider, timings);
  } catch (error) {
    console.error("docs search failed", error);
    log({ status: "error", cached: false, hits: [], timings });
    return new Response("Search failed", { status: 502 });
  }

  const hits = toHits(sections, query);
  timings.total = Date.now() - started;
  log({ status: "ok", cached: false, hits, timings });
  const res = json({ query, provider, hits } satisfies SearchResponse, CACHE_SECONDS);
  res.headers.set("server-timing", serverTiming(timings));
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
  /** Per-step wall time (ms) of an uncached search. */
  timings?: Timings;
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
/** Weight of semantic over keyword relevance when blending the two. */
const SEMANTIC_WEIGHT = 2;
const COLUMNS = "id, path, anchor, title, heading, provider, section";

/**
 * Hybrid retrieval over docs sections, as two parallel branches:
 *
 * - semantic: embed the query → nearest sections in Vectorize → their rows
 *   (by rowid)
 * - keyword: FTS5 BM25, title and heading weighted above body
 *
 * Each branch's scores are min-max normalized and blended, semantic
 * weighted {@link SEMANTIC_WEIGHT}× — the best of the fusions tried on the
 * docs eval set.
 */
const retrieve = async (
  env: Required<Pick<SearchEnv, "AI" | "DOCS_VECTORS" | "DOCS_TEXT">>,
  query: string,
  provider: string | undefined,
  timings: Timings,
): Promise<ScoredSection[]> => {
  const match = words(query)
    .filter((word) => !STOPWORDS.has(word))
    .map((word) => `"${word}"`)
    .join(" OR ");

  const semantic = async () => {
    const { data } = await timed(timings, "embed", env.AI.run(EMBEDDING_MODEL, { text: [query] }));
    const { matches } = await timed(
      timings,
      "vectors",
      env.DOCS_VECTORS.query(data[0]!, {
        topK: CANDIDATES,
        filter: provider ? { provider } : undefined,
      }),
    );
    if (matches.length === 0) return [];
    const { results } = await timed(
      timings,
      "rows",
      env.DOCS_TEXT.prepare(
        `SELECT ${COLUMNS}, substr(body, 1, 600) AS snippet FROM sections
           WHERE rowid IN (${matches.map(() => "?").join(", ")})`,
      )
        .bind(...matches.map((match) => sectionRowid(match.id)))
        .all<SectionRow>(),
    );
    const rows = new Map(results.map((row) => [row.id, row]));
    return matches.flatMap((match) => {
      const row = rows.get(match.id);
      return row ? [{ row, relevance: match.score }] : [];
    });
  };

  const keyword = async () => {
    if (!match) return [];
    const { results } = await timed(
      timings,
      "keyword",
      env.DOCS_TEXT.prepare(
        `SELECT ${COLUMNS}, snippet(sections, 8, '', '', '…', 40) AS snippet,
                bm25(sections, 0, 0, 0, 0, 0, 0, 10.0, 5.0, 1.0) AS rank
           FROM sections
           WHERE sections MATCH ?1 AND (?2 IS NULL OR provider = ?2)
           ORDER BY rank LIMIT ?3`,
      )
        .bind(match, provider ?? null, CANDIDATES)
        .all<SectionRow & { rank: number }>(),
    );
    // BM25 ranks are negative: lower is better.
    return results.map(({ rank, ...row }) => ({ row, relevance: -rank }));
  };

  const [semanticHits, keywordHits] = await Promise.all([semantic(), keyword()]);
  const sections = new Map<string, ScoredSection>();
  // Keyword first, so a section found by both keeps the keyword row (its
  // snippet is centred on the match).
  for (const [hits, weight] of [
    [keywordHits, 1],
    [semanticHits, SEMANTIC_WEIGHT],
  ] as const) {
    const relevances = hits.map((hit) => hit.relevance);
    const lo = Math.min(...relevances);
    const span = Math.max(...relevances) - lo || 1;
    for (const { row, relevance } of hits) {
      const score = (sections.get(row.id)?.score ?? 0) + (weight * (relevance - lo)) / span;
      sections.set(row.id, { ...(sections.get(row.id) ?? row), score });
    }
  }
  const best = Math.max(0, ...[...sections.values()].map((section) => section.score)) || 1;
  return [...sections.values()].map((section) => ({ ...section, score: section.score / best }));
};

/** Wall time (ms) per retrieval step, reported as `Server-Timing` and to Axiom. */
type Timings = Record<string, number>;

const timed = async <A>(timings: Timings, step: string, work: Promise<A>): Promise<A> => {
  const started = Date.now();
  try {
    return await work;
  } finally {
    timings[step] = Date.now() - started;
  }
};

const serverTiming = (timings: Timings) =>
  Object.entries(timings)
    .map(([step, ms]) => `${step};dur=${ms}`)
    .join(", ");

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
