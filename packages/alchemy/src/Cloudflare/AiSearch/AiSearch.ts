import * as Construct from "../../Construct.ts";
import type { Input, InputProps } from "../../Input.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { R2Bucket } from "../R2/R2Bucket.ts";
import {
  AiSearchInstance,
  type AiSearchInstanceProps,
} from "./AiSearchInstance.ts";
import {
  AiSearchToken,
  type AiSearchToken as AiSearchTokenType,
} from "./AiSearchToken.ts";

/**
 * Props common to every AI Search pipeline, regardless of data source. The
 * `type` and `source` of the underlying instance are derived from the
 * source-specific variant ({@link AiSearchR2Props} / {@link
 * AiSearchWebCrawlerProps}), so they're omitted here.
 */
export type AiSearchSharedProps = Omit<
  InputProps<AiSearchInstanceProps, "type">,
  "type" | "source"
>;

/**
 * An R2-backed AI Search pipeline. The presence of `bucket` selects R2 as
 * the data source.
 */
export type AiSearchR2Props = AiSearchSharedProps & {
  /**
   * The R2 bucket to index. AI Search needs a service token to read it;
   * the construct provisions one unless you pass your own `tokenId`.
   */
  bucket: R2Bucket;
  url?: never;
};

/**
 * A web-crawler-backed AI Search pipeline. The presence of `url` selects
 * the web crawler as the data source (no service token needed).
 */
export type AiSearchWebCrawlerProps = AiSearchSharedProps & {
  /**
   * Seed URL to crawl and index. Tune crawl/parse behaviour via
   * `sourceParams.webCrawler`.
   */
  url: Input<string>;
  bucket?: never;
};

/**
 * Props for the {@link AiSearch} construct — a union discriminated by the
 * data source: pass `bucket` for an R2 source or `url` for a web crawl.
 */
export type AiSearchProps = AiSearchR2Props | AiSearchWebCrawlerProps;

/**
 * A convenience construct over {@link AiSearchInstance} that auto-creates the
 * sub-resources an AI Search instance typically needs, so a single call wires
 * up a working pipeline. The data source is chosen by which field you pass —
 * `bucket` (an {@link R2Bucket}) for R2, or `url` for a web crawl:
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
 * Pass an {@link R2Bucket} as `bucket` — its presence selects R2 as the
 * data source.
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("docs", {});
 * const { instance } = yield* Cloudflare.AiSearch("docs-search", { bucket });
 * ```
 *
 * @example Reuse an existing service token
 * ```typescript
 * const { instance } = yield* Cloudflare.AiSearch("docs-search", {
 *   bucket,
 *   tokenId: existingToken.id,
 * });
 * ```
 *
 * @example Web-crawler source
 * Pass a seed `url` instead of a `bucket` to crawl and index a website (no
 * service token needed).
 * ```typescript
 * const { instance } = yield* Cloudflare.AiSearch("site-search", {
 *   url: "https://example.com",
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
 *     const { instance } = yield* Cloudflare.AiSearch("docs-search", { bucket });
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
 * const { instance } = yield* Cloudflare.AiSearch("docs-search", { bucket });
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
  let tokenId = props.tokenId;
  let serviceToken: AiSearchTokenType | undefined;

  // Discriminate the data source on which field the caller passed. R2
  // sources index a bucket and need a service token to read it; web-crawler
  // sources crawl a seed URL and don't.
  let type: "r2" | "web-crawler";
  let source: Input<string>;
  let shared: AiSearchSharedProps;

  if ("bucket" in props && props.bucket !== undefined) {
    const { bucket, url: _url, ...rest } = props;
    type = "r2";
    source = bucket.bucketName;
    shared = rest;

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
    const { url, bucket: _bucket, ...rest } = props;
    type = "web-crawler";
    source = url;
    shared = rest;
  }

  const instance = yield* AiSearchInstance("Instance", {
    ...shared,
    type,
    source,
    tokenId,
  });

  return { instance, token: serviceToken };
});
