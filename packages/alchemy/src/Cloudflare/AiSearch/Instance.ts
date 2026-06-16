import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const AiSearchInstanceTypeId = "Cloudflare.AiSearch.Instance" as const;
type AiSearchInstanceTypeId = typeof AiSearchInstanceTypeId;

/**
 * The kind of data source an AI Search instance indexes.
 */
export type AiSearchInstanceSourceType = "r2" | "web-crawler";

/**
 * Generation model used to answer AI Search queries.
 */
export type AiSearchModel = Exclude<
  NonNullable<aisearch.CreateInstanceRequest["aiSearchModel"]>,
  ""
>;

/**
 * Embedding model used to vectorize indexed content. Cannot be changed
 * after creation (it defines the vector space).
 */
export type AiSearchEmbeddingModel = Exclude<
  NonNullable<aisearch.CreateInstanceRequest["embeddingModel"]>,
  ""
>;

/**
 * Reranking model applied to retrieved results.
 */
export type AiSearchRerankingModel = "@cf/baai/bge-reranker-base";

/**
 * Data-source specific indexing parameters (R2 prefix / include / exclude
 * filters, or web-crawler options).
 */
export type AiSearchSourceParams = NonNullable<
  aisearch.CreateInstanceRequest["sourceParams"]
>;

/**
 * Controls which storage backends are used during indexing.
 */
export type AiSearchIndexMethod = NonNullable<
  aisearch.CreateInstanceRequest["indexMethod"]
>;

/**
 * Keyword indexing options.
 */
export type AiSearchIndexingOptions = NonNullable<
  aisearch.CreateInstanceRequest["indexingOptions"]
>;

/**
 * Custom metadata fields extracted at indexing time.
 */
export type AiSearchCustomMetadata = NonNullable<
  aisearch.CreateInstanceRequest["customMetadata"]
>;

/**
 * Retrieval-time options (boosting and keyword match mode).
 */
export type AiSearchRetrievalOptions = NonNullable<
  aisearch.CreateInstanceRequest["retrievalOptions"]
>;

/**
 * Public REST endpoint configuration for the instance.
 */
export type AiSearchPublicEndpointParams = NonNullable<
  aisearch.CreateInstanceRequest["publicEndpointParams"]
>;

/**
 * Similarity-cache threshold preset.
 */
export type AiSearchCacheThreshold =
  | "super_strict_match"
  | "close_enough"
  | "flexible_friend"
  | "anything_goes";

export type AiSearchInstanceProps = {
  /**
   * Instance identifier (the AI Search "name" shown in the dashboard).
   * Lowercase alphanumeric, hyphens, and underscores. If omitted, a unique
   * id is generated from the app, stage, and logical ID. Changing it
   * triggers a replacement.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  instanceId?: string;
  /**
   * Data source kind: `r2` indexes objects in an R2 bucket, `web-crawler`
   * crawls a seed URL. Changing it triggers a replacement.
   * @default "r2"
   */
  type?: AiSearchInstanceSourceType;
  /**
   * Data source: the R2 bucket name (for `type: "r2"`) or the crawl seed
   * URL (for `type: "web-crawler"`). Changing it triggers a replacement —
   * the index must be rebuilt from scratch.
   */
  source: string;
  /**
   * Source-specific indexing parameters (R2 prefix / include / exclude
   * filters, web-crawler crawl and parse options).
   */
  sourceParams?: AiSearchSourceParams;
  /**
   * Id of the AI Search service token used to access the data source on
   * sync. When omitted, Cloudflare provisions one automatically.
   */
  tokenId?: string;
  /**
   * AI Gateway to route model inference calls through.
   */
  aiGatewayId?: string;
  /**
   * Embedding model used to vectorize content. Cannot be changed after
   * creation — updating this property triggers a replacement.
   * @default service default
   */
  embeddingModel?: AiSearchEmbeddingModel;
  /**
   * Generation model used to answer AI Search queries.
   * @default service default
   */
  aiSearchModel?: AiSearchModel;
  /**
   * Whether to rewrite the user query before retrieval.
   * @default false
   */
  rewriteQuery?: boolean;
  /**
   * Model used to rewrite queries when `rewriteQuery` is enabled.
   */
  rewriteModel?: AiSearchModel;
  /**
   * Whether custom chunking settings are applied during indexing.
   */
  chunk?: boolean;
  /**
   * Chunk size (in tokens) used when splitting documents for indexing.
   * Only affects future indexing runs.
   */
  chunkSize?: number;
  /**
   * Overlap between consecutive chunks, as a percentage (0–30). Only
   * affects future indexing runs.
   */
  chunkOverlap?: number;
  /**
   * Controls which storage backends are used during indexing. Defaults to
   * vector-only.
   */
  indexMethod?: AiSearchIndexMethod;
  /**
   * Keyword indexing options (tokenizer selection).
   */
  indexingOptions?: AiSearchIndexingOptions;
  /**
   * Custom metadata fields extracted at indexing time.
   */
  customMetadata?: AiSearchCustomMetadata;
  /**
   * Whether the similarity cache is enabled.
   * @default false
   */
  cache?: boolean;
  /**
   * Similarity-cache match strictness preset.
   */
  cacheThreshold?: AiSearchCacheThreshold;
  /**
   * Cache entry TTL in seconds. Allowed values: 600, 1800, 3600, 7200,
   * 21600, 43200, 86400, 172800, 259200, 518400.
   */
  cacheTtl?: number;
  /**
   * Whether retrieved results are reranked before generation.
   * @default false
   */
  reranking?: boolean;
  /**
   * Model used for reranking when `reranking` is enabled.
   */
  rerankingModel?: AiSearchRerankingModel;
  /**
   * Retrieval-time options (boosting and keyword match mode).
   */
  retrievalOptions?: AiSearchRetrievalOptions;
  /**
   * How vector and keyword results are fused: `max` or `rrf`
   * (reciprocal rank fusion).
   */
  fusionMethod?: "max" | "rrf";
  /**
   * Maximum number of results returned by retrieval.
   */
  maxNumResults?: number;
  /**
   * Minimum similarity score for a result to be returned.
   */
  scoreThreshold?: number;
  /**
   * Public REST endpoint configuration (search / chat-completions / MCP).
   */
  publicEndpointParams?: AiSearchPublicEndpointParams;
  /**
   * Interval between automatic syncs, in seconds. Allowed values: 900,
   * 1800, 3600, 7200, 14400, 21600, 43200, 86400.
   */
  syncInterval?: number;
};

export type AiSearchInstanceAttributes = {
  /**
   * AI Search instance id. Lowercase alphanumeric, hyphens, underscores.
   */
  id: string;
  /**
   * The Cloudflare account the instance belongs to.
   */
  accountId: string;
  /**
   * Data source kind (`r2` or `web-crawler`).
   */
  type: AiSearchInstanceSourceType;
  /**
   * Data source (R2 bucket name or crawl seed URL).
   */
  source: string | undefined;
  /**
   * Id of the AI Search service token used to access the data source.
   */
  tokenId: string | undefined;
  /**
   * AI Gateway inference calls are routed through.
   */
  aiGatewayId: string | undefined;
  /**
   * Embedding model used to vectorize content.
   */
  embeddingModel: string | undefined;
  /**
   * Generation model used to answer queries.
   */
  aiSearchModel: string | undefined;
  /**
   * Current instance status (indexing is asynchronous).
   */
  status: string | undefined;
  /**
   * Whether the instance is paused.
   */
  paused: boolean | undefined;
  /**
   * Id of the public REST endpoint, when enabled.
   */
  publicEndpointId: string | undefined;
  /**
   * When the instance was created.
   */
  createdAt: string | undefined;
  /**
   * When the instance was last modified.
   */
  modifiedAt: string | undefined;
};

export type AiSearchInstance = Resource<
  AiSearchInstanceTypeId,
  AiSearchInstanceProps,
  AiSearchInstanceAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare AI Search (formerly AutoRAG) instance — a fully managed
 * retrieval-augmented generation pipeline over your own data.
 *
 * An instance continuously indexes a data source (an R2 bucket or a web
 * crawl), embeds it into a managed Vectorize index, and answers search and
 * chat queries against it. Creation returns immediately; the initial
 * indexing run happens asynchronously.
 *
 * The instance `id`, `type`, `source`, and `embeddingModel` are fixed at
 * creation — changing any of them triggers a replacement. Everything else
 * (models, chunking, caching, reranking, public endpoint, sync interval)
 * is mutable in place.
 *
 * @section Creating an Instance
 * @example R2-backed instance
 * ```typescript
 * const bucket = yield* Cloudflare.R2Bucket("docs", {});
 * const search = yield* Cloudflare.AiSearchInstance("docs-search", {
 *   source: bucket.bucketName,
 * });
 * ```
 *
 * @example Tuned retrieval settings
 * ```typescript
 * const search = yield* Cloudflare.AiSearchInstance("docs-search", {
 *   source: bucket.bucketName,
 *   aiSearchModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *   chunkSize: 512,
 *   chunkOverlap: 64,
 *   maxNumResults: 20,
 *   cache: true,
 *   cacheThreshold: "close_enough",
 * });
 * ```
 *
 * @example Web-crawler instance
 * ```typescript
 * const search = yield* Cloudflare.AiSearchInstance("site-search", {
 *   type: "web-crawler",
 *   source: "https://example.com",
 *   sourceParams: {
 *     webCrawler: {
 *       parseType: "crawl",
 *       crawlOptions: { depth: 2, includeSubdomains: true },
 *       storeOptions: { storageId: "my-crawl-bucket", storageType: "r2" },
 *     },
 *   },
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ai-search/
 */
export const AiSearchInstance = Resource<AiSearchInstance>(
  AiSearchInstanceTypeId,
);

/**
 * Returns true if the given value is an AiSearchInstance resource.
 */
export const isAiSearchInstance = (value: unknown): value is AiSearchInstance =>
  Predicate.hasProperty(value, "Type") && value.Type === AiSearchInstanceTypeId;

export const AiSearchInstanceProvider = () =>
  Provider.succeed(AiSearchInstance, {
    stables: ["id", "accountId", "type", "embeddingModel", "createdAt"],
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The instance id is its identity — renaming is a replacement.
      const newId = yield* createInstanceId(id, news.instanceId);
      const oldId =
        output?.id ?? (yield* createInstanceId(id, olds.instanceId));
      if (newId !== oldId) {
        return { action: "replace" } as const;
      }
      // When the user pinned an explicit `instanceId`, the replacement's
      // create would collide with the still-existing old instance — the
      // old one must be deleted first. Generated ids get a fresh suffix
      // from the new Instance ID, so create-before-delete is safe there.
      const replace = {
        action: "replace",
        deleteFirst: news.instanceId !== undefined || undefined,
      } as const;
      // The data-source kind and location are fixed at creation; changing
      // either requires re-indexing from scratch (a replacement).
      if ((news.type ?? "r2") !== (output?.type ?? olds.type ?? "r2")) {
        return replace;
      }
      const oldSource = output?.source ?? olds.source;
      if (oldSource !== undefined && news.source !== oldSource) {
        return replace;
      }
      // The embedding model defines the vector space and is immutable.
      const oldEmbedding =
        normalize(output?.embeddingModel) ?? olds.embeddingModel;
      if (
        news.embeddingModel !== undefined &&
        oldEmbedding !== undefined &&
        news.embeddingModel !== oldEmbedding
      ) {
        return replace;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      // The id is deterministic (explicit prop or generated from the
      // logical id + instance id), so a cold read (lost state) resolves
      // the same identifier as the original create did.
      const instanceId =
        output?.id ?? (yield* createInstanceId(id, olds?.instanceId));
      const observed = yield* getInstance(acct, instanceId);
      return observed ? toAttributes(observed, acct) : undefined;
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // Enumerate every instance id in the account, paginating
      // exhaustively (the list payload omits some fields `read`
      // returns).
      const ids = yield* aisearch.listInstances.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((instance) => instance.id),
          ),
        ),
      );
      // Hydrate each into the exact `read` Attributes shape; an item
      // that vanished between list and read (typed NotFound) is
      // dropped.
      const rows = yield* Effect.forEach(
        ids,
        (instanceId) =>
          getInstance(accountId, instanceId).pipe(
            Effect.map((observed) =>
              observed ? toAttributes(observed, accountId) : undefined,
            ),
          ),
        { concurrency: 10 },
      );
      return rows.filter(
        (row): row is AiSearchInstanceAttributes => row !== undefined,
      );
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const instanceId =
        output?.id ?? (yield* createInstanceId(id, news.instanceId));

      // Observe — `output.id` is a cache, not a guarantee: a NotFound
      // falls through to "missing" and we recreate.
      let observed = yield* getInstance(acct, instanceId);

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete): create with the
        // full desired body. If Cloudflare rejects the request because
        // the instance already exists (a race), fall through to the
        // sync path against the observed instance.
        const ensured = yield* aisearch
          .createInstance({
            accountId: acct,
            id: instanceId,
            type: news.type ?? "r2",
            ...toMutableBody(news),
          })
          .pipe(
            retryTokenPropagation,
            Effect.map((created) => ({
              created: true as const,
              instance: created as ObservedInstance,
            })),
            Effect.catchTag("InstanceAlreadyExists", (originalError) =>
              Effect.gen(function* () {
                const existing = yield* getInstance(acct, instanceId);
                if (!existing) return yield* Effect.fail(originalError);
                return { created: false as const, instance: existing };
              }),
            ),
          );
        if (ensured.created) {
          // Indexing starts asynchronously; we deliberately do NOT wait
          // for the first sync to finish.
          return toAttributes(ensured.instance, acct);
        }
        observed = ensured.instance;
      }

      // Sync — diff observed cloud state against the desired mutable
      // config; skip the PUT entirely on a no-op. Only fields the user
      // actually set participate in the diff; for the rest the observed
      // value is preserved in the full PUT body.
      const desired = toMutableBody(news);
      const observedRecord = observed as unknown as Record<string, unknown>;
      const dirty = Object.entries(desired).some(
        ([key, value]) =>
          value !== undefined &&
          !deepEqual(normalize(observedRecord[key]), normalize(value), {
            stripNullish: true,
          }),
      );
      if (!dirty) {
        return toAttributes(observed, acct);
      }

      const updated = yield* aisearch
        .updateInstance({
          accountId: acct,
          id: instanceId,
          ...preserveObserved(observed),
          ...defined(desired),
        })
        .pipe(retryTokenPropagation);
      return toAttributes(updated, acct);
    }),
    delete: Effect.fn(function* ({ output }) {
      // The managed Vectorize index is torn down asynchronously; a
      // missing instance (already deleted) is success.
      yield* aisearch
        .deleteInstance({ accountId: output.accountId, id: output.id })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

/**
 * On a greenfield create Cloudflare auto-provisions an R2 service token for
 * the instance to read its source bucket. That token is validated
 * eventually-consistently, so the create/update PUT can transiently reject
 * with `InvalidTokenCredentials` (code 7012, message
 * `ai_search_instance_invalid_token`) before the token has propagated. Ride
 * the blip out with a short, bounded retry; a genuinely invalid token still
 * fails once the retries are exhausted.
 */
const retryTokenPropagation = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "InvalidTokenCredentials",
      schedule: Schedule.exponential("1 second"),
      times: 6,
    }),
  );

type ObservedInstance = aisearch.ReadInstanceResponse;

/**
 * Read an instance by id, mapping "gone" (`NotFound`, Cloudflare error
 * code 7002) to `undefined`.
 */
const getInstance = (accountId: string, id: string) =>
  aisearch
    .readInstance({ accountId, id })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const createInstanceId = (id: string, instanceId: string | undefined) =>
  Effect.gen(function* () {
    return instanceId ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

/**
 * Cloudflare returns `null` (and sometimes `""` for model enums) for
 * unconfigured optional fields; desired-state shapes leave them
 * `undefined`. Collapse both to `undefined` for diffing.
 */
const normalize = <T>(value: T | "" | null | undefined): T | undefined =>
  value === "" || value == null ? undefined : value;

type MutableBody = ReturnType<typeof toMutableBody>;

/**
 * The mutable slice of the desired state, shaped for the create/update
 * request bodies. Immutable props (`id`, `type`) are handled separately.
 */
const toMutableBody = (news: AiSearchInstanceProps) => ({
  source: news.source as string,
  sourceParams: news.sourceParams,
  tokenId: news.tokenId as string | undefined,
  aiGatewayId: news.aiGatewayId as string | undefined,
  embeddingModel: news.embeddingModel,
  aiSearchModel: news.aiSearchModel,
  rewriteQuery: news.rewriteQuery,
  rewriteModel: news.rewriteModel,
  chunk: news.chunk,
  chunkSize: news.chunkSize,
  chunkOverlap: news.chunkOverlap,
  indexMethod: news.indexMethod,
  indexingOptions: news.indexingOptions,
  customMetadata: news.customMetadata,
  cache: news.cache,
  cacheThreshold: news.cacheThreshold,
  cacheTtl: news.cacheTtl,
  reranking: news.reranking,
  rerankingModel: news.rerankingModel,
  retrievalOptions: news.retrievalOptions,
  fusionMethod: news.fusionMethod,
  maxNumResults: news.maxNumResults,
  scoreThreshold: news.scoreThreshold,
  publicEndpointParams: news.publicEndpointParams,
  syncInterval: news.syncInterval,
});

/**
 * The update API is a PUT — fields the user did not set are preserved by
 * sending the observed values back. Observed `null`s are omitted (the
 * field was never configured).
 */
const preserveObserved = (observed: ObservedInstance) =>
  defined({
    source: normalize(observed.source),
    sourceParams: normalize(observed.sourceParams),
    tokenId: normalize(observed.tokenId),
    aiGatewayId: normalize(observed.aiGatewayId),
    embeddingModel: normalize(observed.embeddingModel),
    aiSearchModel: normalize(observed.aiSearchModel),
    rewriteQuery: normalize(observed.rewriteQuery),
    rewriteModel: normalize(observed.rewriteModel),
    chunkSize: normalize(observed.chunkSize),
    chunkOverlap: normalize(observed.chunkOverlap),
    indexMethod: normalize(observed.indexMethod),
    indexingOptions: normalize(observed.indexingOptions),
    customMetadata: normalize(observed.customMetadata),
    cache: normalize(observed.cache),
    cacheThreshold: normalize(observed.cacheThreshold),
    cacheTtl: normalize(observed.cacheTtl),
    reranking: normalize(observed.reranking),
    rerankingModel: normalize(observed.rerankingModel),
    retrievalOptions: normalize(observed.retrievalOptions),
    fusionMethod: normalize(observed.fusionMethod),
    maxNumResults: normalize(observed.maxNumResults),
    scoreThreshold: normalize(observed.scoreThreshold),
    publicEndpointParams: normalize(observed.publicEndpointParams),
    syncInterval: normalize(observed.syncInterval),
  }) as Partial<MutableBody>;

/** Strip `undefined` entries so they don't override spread order. */
const defined = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;

const toAttributes = (
  instance:
    | aisearch.ReadInstanceResponse
    | aisearch.CreateInstanceResponse
    | aisearch.UpdateInstanceResponse,
  accountId: string,
): AiSearchInstanceAttributes => ({
  id: instance.id,
  accountId,
  // Distilled widens generated string enums to open unions.
  type: (normalize(instance.type) ?? "r2") as AiSearchInstanceSourceType,
  source: normalize(instance.source),
  tokenId: normalize(instance.tokenId),
  aiGatewayId: normalize(instance.aiGatewayId),
  embeddingModel: normalize(instance.embeddingModel),
  aiSearchModel: normalize(instance.aiSearchModel),
  status: normalize(instance.status),
  paused: instance.paused ?? undefined,
  publicEndpointId: normalize(instance.publicEndpointId),
  createdAt: normalize(instance.createdAt),
  modifiedAt: normalize(instance.modifiedAt),
});
