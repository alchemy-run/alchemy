import * as functions from "@distilled.cloud/convex/functions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type ConvexFunctionError, onHost, unwrap } from "./BindingHttp.ts";
import type { Deployment } from "./Deployment.ts";

export type QueryBatchError = ConvexFunctionError | functions.QueryBatchError;

/** One query in a batch. */
export interface QueryBatchItem {
  /** The function, such as `messages:list`. */
  path: string;
  /** Its arguments. */
  args?: Record<string, unknown>;
}

/** Run several queries at one point in time. Results are in the order given. */
export type QueryBatchClient = <A extends unknown[] = unknown[]>(
  queries: ReadonlyArray<QueryBatchItem>,
) => Effect.Effect<A, QueryBatchError, RuntimeContext>;

/**
 * Run several public Convex queries in one request, from a Worker, Lambda or
 * other host. Every query sees the same snapshot of the database.
 *
 * It needs no credentials and grants nothing. If any query throws, the batch
 * fails with `ConvexFunctionError`.
 *
 * ### Calling Functions
 * **Example:** Read two queries together
 * ```typescript
 * Effect.gen(function* () {
 *   const batch = yield* Convex.QueryBatch(Backend);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const results = yield* batch([{ path: "messages:list" }, { path: "users:me" }]);
 *       return yield* HttpServerResponse.json(results);
 *     }),
 *   };
 * }).pipe(Effect.provide(Convex.QueryBatchHttp));
 * ```
 *
 * @binding
 * @product Functions
 */
export interface QueryBatch extends Binding.Service<
  QueryBatch,
  "Convex.QueryBatch",
  (deployment: Deployment) => Effect.Effect<QueryBatchClient>
> {}

export const QueryBatch = Binding.Service<QueryBatch>("Convex.QueryBatch");

/** Implementation over Convex's public HTTP API, usable from any host. */
export const QueryBatchHttp = Layer.effect(
  QueryBatch,
  Effect.succeed(
    Effect.fn(function* (deployment: Deployment) {
      const on = onHost(yield* deployment.url);
      const client: QueryBatchClient = <A extends unknown[] = unknown[]>(
        queries: ReadonlyArray<QueryBatchItem>,
      ) =>
        functions
          .queryBatch({
            queries: queries.map(({ path, args = {} }) => ({ path, args, format: "json" })),
          })
          .pipe(
            Effect.flatMap(({ results }) =>
              Effect.forEach(results, (response, index) =>
                unwrap(queries[index]?.path ?? "", response),
              ),
            ),
            Effect.map((values) => values as A),
            on,
          );
      return client;
    }),
  ),
);
