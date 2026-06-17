import * as Construct from "../../Construct.ts";
import type { Input, InputProps } from "../../Input.ts";
import { isResource } from "../../Resource.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { R2Bucket } from "../R2/R2Bucket.ts";
import {
  AiSearchInstance,
  type AiSearchInstanceProps,
  type AiSearchSourceParams,
} from "./AiSearchInstance.ts";
import {
  AiSearchToken,
  type AiSearchToken as AiSearchTokenType,
} from "./AiSearchToken.ts";

type WebCrawlerParams = NonNullable<AiSearchSourceParams["webCrawler"]>;

/**
 * How a web crawler discovers and parses pages — Cloudflare's `parseType`
 * folded together with its parse options. Defaults to `type: "sitemap"`.
 */
export type AiSearchParse = {
  /**
   * How pages are discovered:
   * - `"sitemap"` (default) — read `<seed>/sitemap.xml` (found via
   *   `robots.txt`) and index the URLs it lists.
   * - `"crawl"` — start at `source` and follow links.
   * - `"feed-rss"` — treat the seed as an RSS / Atom feed.
   * @default "sitemap"
   */
  type?: NonNullable<WebCrawlerParams["parseType"]>;
} & NonNullable<WebCrawlerParams["parseOptions"]>;

/**
 * Link-discovery options for a web crawler (mainly for `parse.type: "crawl"`):
 * `depth`, `includeSubdomains`, `includeExternalLinks`, `maxAge`, and `source`
 * (`"all"` | `"sitemaps"` | `"links"`).
 */
export type AiSearchCrawl = NonNullable<WebCrawlerParams["crawlOptions"]>;

/**
 * Where crawled content is stored. Cloudflare provisions managed storage by
 * default; set this to store output in an R2 bucket you control.
 */
export type AiSearchStore = {
  /** R2 bucket to store crawl output in. */
  bucket: R2Bucket;
  /** R2 data-residency jurisdiction for the store bucket. */
  jurisdiction?: string;
};

/**
 * Props common to every AI Search pipeline, regardless of data source. The
 * underlying instance's `type`, `source`, and `sourceParams` are derived from
 * the source-specific variant, so they're omitted here.
 */
export type AiSearchSharedProps = Omit<
  InputProps<AiSearchInstanceProps, "type">,
  "type" | "source" | "sourceParams"
>;

/**
 * An R2-backed AI Search pipeline. Passing an {@link R2Bucket} as `source`
 * selects R2 as the data source.
 */
export type AiSearchR2Props = AiSearchSharedProps & {
  /**
   * The R2 bucket to index. AI Search needs a service token to read it; the
   * construct provisions one unless you pass your own `tokenId`.
   */
  source: R2Bucket;
  /** Only index object keys under this prefix. */
  prefix?: string;
  /** Glob patterns of object keys to index. */
  include?: string[];
  /** Glob patterns of object keys to skip. */
  exclude?: string[];
  /** R2 data-residency jurisdiction of the source bucket. */
  jurisdiction?: string;
  parse?: never;
  crawl?: never;
  store?: never;
};

/**
 * A web-crawler-backed AI Search pipeline. Passing a URL as `source` selects
 * the web crawler as the data source (no service token needed).
 */
export type AiSearchWebCrawlerProps = AiSearchSharedProps & {
  /** Seed URL to crawl and index. */
  source: Input<string>;
  /** How pages are discovered and parsed. */
  parse?: AiSearchParse;
  /** How links are followed from the seed. */
  crawl?: AiSearchCrawl;
  /** Where crawl output is stored (defaults to managed storage). */
  store?: AiSearchStore;
  prefix?: never;
  include?: never;
  exclude?: never;
  jurisdiction?: never;
};

/**
 * Props for the {@link AiSearch} construct — a union discriminated by what you
 * pass as `source`: an {@link R2Bucket} for an R2 source, or a URL string for
 * a web crawl.
 */
export type AiSearchProps = AiSearchR2Props | AiSearchWebCrawlerProps;

/** Drop `undefined` entries; return `undefined` when nothing is left. */
const clean = <T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]: T[K] } | undefined => {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  return entries.length
    ? (Object.fromEntries(entries) as { [K in keyof T]: T[K] })
    : undefined;
};

/**
 * A convenience construct over {@link AiSearchInstance} that auto-creates the
 * sub-resources an AI Search instance typically needs, so a single call wires
 * up a working pipeline. The data source is chosen by what you pass as
 * `source` — an {@link R2Bucket} for R2, or a URL for a web crawl:
 *
 * - For an R2 source, it mints a least-privilege {@link AccountApiToken}
 *   (`AI Search Index Engine`) and an {@link AiSearchToken} wrapping it
 *   (stable children `Token`), then passes that token to the instance.
 *   Cloudflare requires a service token to read an R2 bucket and only
 *   provisions one through the dashboard / Wrangler — never on a
 *   programmatic API create — so the construct provisions it for you. Pass
 *   your own `tokenId` to skip minting and reuse an existing token.
 * - It creates the {@link AiSearchInstance} (child `Instance`) with the
 *   remaining props.
 *
 * Drop down to the low-level resources directly when you need to share a
 * token across instances, adopt an existing one, or bind a namespace.
 *
 * @resource
 * @product AI Search
 * @category AI
 * @section Creating an AI Search pipeline
 * @example R2-backed instance (token provisioned for you)
 * Pass an {@link R2Bucket} as `source` — its presence selects R2.
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("docs", {});
 * const { instance } = yield* Cloudflare.AiSearch("docs-search", {
 *   source: bucket,
 * });
 * ```
 *
 * @example Index only part of a bucket
 * ```typescript
 * const { instance } = yield* Cloudflare.AiSearch("docs-search", {
 *   source: bucket,
 *   prefix: "docs/",
 *   include: ["published/"],
 *   exclude: ["drafts/"],
 * });
 * ```
 *
 * @example Reuse an existing service token
 * ```typescript
 * const { instance } = yield* Cloudflare.AiSearch("docs-search", {
 *   source: bucket,
 *   tokenId: existingToken.id,
 * });
 * ```
 *
 * @example Web-crawler source
 * Pass a URL as `source` to crawl and index a website (no service token
 * needed). `parse.type` defaults to `"sitemap"`; use `"crawl"` to follow
 * links from the seed instead.
 * ```typescript
 * const { instance } = yield* Cloudflare.AiSearch("site-search", {
 *   source: "https://example.com",
 *   parse: { type: "crawl", contentSelector: [{ path: "/docs", selector: "main" }] },
 *   crawl: { depth: 3, includeSubdomains: true },
 * });
 * ```
 *
 * @example Store crawl output in your own bucket
 * ```typescript
 * const store = yield* Cloudflare.R2Bucket("crawl-store", {});
 * const { instance } = yield* Cloudflare.AiSearch("site-search", {
 *   source: "https://example.com",
 *   parse: { type: "crawl" },
 *   store: { bucket: store },
 * });
 * ```
 *
 * @section Binding to an Effect Worker
 *
 * The returned `instance` is an {@link AiSearchInstance}. Bind it during the
 * Worker's init phase with `Cloudflare.AiSearchInstance.bind(instance)`, which
 * attaches the single-instance `ai_search` binding and hands back an
 * Effect-native client whose `search` / `aiSearch` methods return `Effect`s.
 * Provide `AiSearchInstanceBindingLive` in the Worker's runtime layer.
 *
 * @example Effect Worker that answers from AI Search
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "api",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const bucket = yield* Cloudflare.R2Bucket("docs", {});
 *     const { instance } = yield* Cloudflare.AiSearch("docs-search", {
 *       source: bucket,
 *     });
 *     const search = yield* Cloudflare.AiSearchInstance.bind(instance);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const query = new URL(request.url).searchParams.get("q") ?? "";
 *         const answer = yield* search.aiSearch({ query });
 *         return yield* HttpServerResponse.json(answer);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.AiSearchInstanceBindingLive)),
 * ) {}
 * ```
 *
 * @section Binding to an Async Worker
 *
 * For a vanilla `async fetch` Worker, pass the `instance` under `Worker.env`.
 * The engine attaches the same single-instance `ai_search` binding (see
 * `toBinding` in `WorkerAsyncBindings.ts`), orders the deploy
 * bucket → instance → worker, and `InferEnv` types `env.SEARCH` as the
 * runtime `AutoRAG` handle — no hand-written types.
 *
 * @example Async Worker that answers from AI Search
 * ```typescript
 * // stack.ts
 * const bucket = yield* Cloudflare.R2Bucket("docs", {});
 * const { instance } = yield* Cloudflare.AiSearch("docs-search", {
 *   source: bucket,
 * });
 *
 * export const Api = Cloudflare.Worker("api", {
 *   main: "./worker.ts",
 *   env: { SEARCH: instance },
 * });
 * export type ApiEnv = Cloudflare.InferEnv<typeof Api>;
 *
 * // worker.ts
 * import type { ApiEnv } from "./stack.ts";
 * export default {
 *   async fetch(request: Request, env: ApiEnv): Promise<Response> {
 *     const query = new URL(request.url).searchParams.get("q") ?? "";
 *     const answer = await env.SEARCH.aiSearch({ query });
 *     return Response.json(answer);
 *   },
 * };
 * ```
 *
 * @see https://developers.cloudflare.com/ai-search/
 */
export const AiSearch = Construct.fn(function* (
  id: string,
  props: AiSearchProps,
) {
  const {
    source,
    prefix,
    include,
    exclude,
    jurisdiction,
    parse,
    crawl,
    store,
    ...shared
  } = props;

  let tokenId = shared.tokenId;
  let serviceToken: AiSearchTokenType | undefined;
  let type: "r2" | "web-crawler";
  let instanceSource: Input<string>;
  let sourceParams: Input<AiSearchSourceParams> | undefined;

  // Discriminate the data source on what `source` is: an R2Bucket (a resource)
  // indexes a bucket and needs a service token to read it; a URL crawls a seed
  // and doesn't.
  if (isResource(source)) {
    const bucket = source as R2Bucket;
    type = "r2";
    instanceSource = bucket.bucketName;
    sourceParams = clean({
      prefix,
      includeItems: include,
      excludeItems: exclude,
      r2Jurisdiction: jurisdiction,
    }) as Input<AiSearchSourceParams> | undefined;

    // Cloudflare requires a service token to read an R2 source and only
    // auto-creates one via the dashboard/Wrangler — not on a programmatic
    // API create. Mint one ourselves unless the caller passed a `tokenId`.
    if (tokenId === undefined) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const apiToken = yield* AccountApiToken("Token", {
        policies: [
          {
            effect: "allow",
            permissionGroups: ["AI Search Index Engine"],
            resources: {
              [`com.cloudflare.api.account.${accountId}`]: "*",
            },
          },
        ],
      });
      serviceToken = yield* AiSearchToken("Token", {
        cfApiId: apiToken.tokenId,
        cfApiKey: apiToken.value,
      });
      tokenId = serviceToken.id;
    }
  } else {
    type = "web-crawler";
    instanceSource = source as Input<string>;

    const { type: parseType, ...parseOptions } = parse ?? {};
    const webCrawler = clean({
      parseType,
      parseOptions: clean(parseOptions),
      crawlOptions: crawl ? clean(crawl) : undefined,
      storeOptions: store
        ? clean({
            storageId: store.bucket.bucketName,
            storageType: "r2" as const,
            r2Jurisdiction: store.jurisdiction,
          })
        : undefined,
    });
    sourceParams = webCrawler
      ? ({ webCrawler } as Input<AiSearchSourceParams>)
      : undefined;
  }

  const instance = yield* AiSearchInstance("Instance", {
    ...shared,
    type,
    source: instanceSource,
    tokenId,
    sourceParams,
  });

  return { instance, token: serviceToken };
});
