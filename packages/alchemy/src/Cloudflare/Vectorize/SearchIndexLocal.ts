import type * as runtime from "@cloudflare/workers-types";
import type { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { type SearchIndexClient, SearchIndex } from "./SearchIndex.ts";
import type { Index } from "./VectorizeIndex.ts";

/**
 * Local implementation of the {@link SearchIndex} binding — talks to a
 * Vectorize index over the Cloudflare HTTP API using the **current
 * credentials** instead of a native Worker binding (`SearchIndexBinding`).
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can
 * insert, upsert, query, and fetch vectors with the same client you'd use
 * inside a Worker — no Worker host, no `host.bind`, no minted token:
 *
 * @example Seeding an index from an Action
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const vec = yield* Cloudflare.Vectorize.SearchIndex(index);
 *     return Effect.fn(function* () {
 *       yield* vec.upsert([
 *         { id: "1", values: [0.1, 0.2, 0.3, 0.4] },
 *         { id: "2", values: [0.9, 0.8, 0.7, 0.6] },
 *       ]);
 *       const matches = yield* vec.query([0.1, 0.2, 0.3, 0.4], { topK: 1 });
 *       return matches;
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Vectorize.SearchIndexLocal)),
 * );
 * ```
 *
 * The index name is resolved at apply time through the ambient
 * {@link RuntimeContext} (in an Action, that's the resolve context the engine
 * provides around the body), so `SearchIndex(index)` works even though the
 * index is created in the same deploy.
 *
 * Two methods have no Cloudflare HTTP equivalent and therefore
 * `Effect.die` when called on the Local client:
 * - `raw` — there is no HTTP-backed `runtime.Vectorize` object to hand back.
 * - `queryById` — the HTTP query endpoint only accepts a raw vector, not an id.
 */
export const SearchIndexLocal = Layer.effect(
  SearchIndex,
  Effect.gen(function* () {
    // Account + credentials are ambient during stack-eval (the stack's
    // providers layer). Capture the full context so the HTTP ops run with the
    // current credentials — no `host.bind`, no minted token.
    const { accountId } = yield* yield* CloudflareEnvironment;
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();

    return Effect.fn(function* (index: Index) {
      // Deferred accessor — resolves the index name against the tracker at
      // apply time (in an Action, that's the engine's resolve context).
      const indexName = yield* index.indexName;

      // Run a distilled Vectorize op with the captured credentials, resolving
      // the index name first. The captured credentials context is provided
      // ONLY around the distilled op — never around the `indexName` accessor,
      // which must resolve against the ambient apply-time RuntimeContext (same
      // split as the D1 / KV Local variants). `orDie` mirrors the native
      // binding, whose client methods surface transport failures as defects.
      const local = <A, E>(
        fn: (
          name: string,
        ) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
      ): Effect.Effect<A> =>
        Effect.flatMap(indexName, (name) =>
          fn(name).pipe(Effect.provideContext(context)),
        ).pipe(Effect.orDie);

      return {
        raw: Effect.die(
          new Error(
            "SearchIndexLocal: `raw` is not available over the Vectorize HTTP API — use a native Worker binding (SearchIndexBinding) for direct access.",
          ),
        ),
        describe: () =>
          local((name) =>
            vectorize
              .infoIndex({ accountId, indexName: name })
              .pipe(Effect.map(toIndexInfo)),
          ),
        query: (vector, options) =>
          local((name) =>
            vectorize
              .queryIndex({
                accountId,
                indexName: name,
                vector: Array.from(vector),
                topK: options?.topK,
                returnValues: options?.returnValues,
                returnMetadata: toReturnMetadata(options?.returnMetadata),
                filter: options?.filter,
              })
              .pipe(Effect.map(toMatches)),
          ),
        queryById: () =>
          Effect.die(
            new Error(
              "SearchIndexLocal: `queryById` is not supported over the Vectorize HTTP API — it only accepts a raw query vector. Fetch the vector with `getByIds` and pass its values to `query`.",
            ),
          ),
        insert: (vectors) =>
          local((name) =>
            vectorize
              .insertIndex({
                accountId,
                indexName: name,
                body: toNdjsonBlob(vectors),
              })
              .pipe(Effect.map(toMutation)),
          ),
        upsert: (vectors) =>
          local((name) =>
            vectorize
              .upsertIndex({
                accountId,
                indexName: name,
                body: toNdjsonBlob(vectors),
              })
              .pipe(Effect.map(toMutation)),
          ),
        deleteByIds: (ids) =>
          local((name) =>
            vectorize
              .deleteByIdsIndex({ accountId, indexName: name, ids })
              .pipe(Effect.map(toMutation)),
          ),
        getByIds: (ids) =>
          local((name) =>
            vectorize
              .getByIdsIndex({ accountId, indexName: name, ids })
              .pipe(
                Effect.map(
                  (result) => (result ?? []) as runtime.VectorizeVector[],
                ),
              ),
          ),
      } satisfies SearchIndexClient;
    });
  }),
);

/**
 * Serialize vectors to an ndjson Blob — the raw `application/x-ndjson` request
 * body of the Vectorize v2 insert/upsert endpoints.
 */
const toNdjsonBlob = (vectors: runtime.VectorizeVector[]): Blob =>
  new Blob([toNdjson(vectors)]);

/** Serialize vectors to ndjson — one JSON vector per line. */
const toNdjson = (vectors: runtime.VectorizeVector[]): string =>
  vectors
    .map((v) =>
      JSON.stringify({
        id: v.id,
        // A `VectorFloatArray` (Float32Array) would `JSON.stringify` to an
        // object, not an array — normalize to a plain number array.
        values: Array.from(v.values),
        ...(v.namespace !== undefined ? { namespace: v.namespace } : {}),
        ...(v.metadata !== undefined ? { metadata: v.metadata } : {}),
      }),
    )
    .join("\n");

const toReturnMetadata = (
  value: runtime.VectorizeQueryOptions["returnMetadata"],
): "none" | "indexed" | "all" | undefined =>
  value === undefined
    ? undefined
    : typeof value === "boolean"
      ? value
        ? "all"
        : "none"
      : value;

const toMutation = (r: {
  mutationId?: string | null;
}): runtime.VectorizeAsyncMutation => ({ mutationId: r.mutationId ?? "" });

const toIndexInfo = (
  r: vectorize.InfoIndexResponse,
): runtime.VectorizeIndexInfo =>
  ({
    vectorCount: r.vectorCount ?? 0,
    dimensions: r.dimensions ?? 0,
    processedUpToDatetime: r.processedUpToDatetime ?? undefined,
    processedUpToMutation: r.processedUpToMutation ?? undefined,
  }) as unknown as runtime.VectorizeIndexInfo;

const toMatches = (r: vectorize.QueryIndexResponse): runtime.VectorizeMatches =>
  ({
    count: r.count ?? r.matches?.length ?? 0,
    matches: (r.matches ?? []).map((m) => ({
      id: m.id ?? "",
      score: m.score ?? 0,
      ...(m.values != null ? { values: m.values } : {}),
      ...(m.namespace != null ? { namespace: m.namespace } : {}),
      ...(m.metadata != null ? { metadata: m.metadata } : {}),
    })),
  }) as unknown as runtime.VectorizeMatches;
