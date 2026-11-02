import * as functions from "@distilled.cloud/convex/functions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type ConvexFunctionError, onHost, unwrap } from "./BindingHttp.ts";
import type { Deployment } from "./Deployment.ts";

export type QueryError = ConvexFunctionError | functions.QueryError;

/** Run a query by path, such as `messages:list`. */
export type QueryClient = <A = unknown>(
  path: string,
  args?: Record<string, unknown>,
) => Effect.Effect<A, QueryError, RuntimeContext>;

/**
 * Run a public Convex query from a Worker, Lambda or other host.
 *
 * It needs no credentials and grants nothing: the host gets the deployment's
 * URL. A function that throws fails with `ConvexFunctionError`. Values use
 * Convex's JSON format, so `Int64` and `Bytes` arrive as tagged objects.
 *
 * ### Calling a Function
 * **Example:** Run a query in a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const run = yield* Convex.Query(Backend);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const result = yield* run("messages:list");
 *       return yield* HttpServerResponse.json(result);
 *     }),
 *   };
 * }).pipe(Effect.provide(Convex.QueryHttp));
 * ```
 *
 * @binding
 * @product Functions
 */
export interface Query extends Binding.Service<
  Query,
  "Convex.Query",
  (deployment: Deployment) => Effect.Effect<QueryClient>
> {}

export const Query = Binding.Service<Query>("Convex.Query");

/** Implementation over Convex's public HTTP API, usable from any host. */
export const QueryHttp = Layer.effect(
  Query,
  Effect.succeed(
    Effect.fn(function* (deployment: Deployment) {
      const on = onHost(yield* deployment.url);
      const client: QueryClient = <A = unknown>(path: string, args: Record<string, unknown> = {}) =>
        functions.query({ path, args, format: "json" }).pipe(
          Effect.flatMap((response) => unwrap<A>(path, response)),
          on,
        );
      return client;
    }),
  ),
);
