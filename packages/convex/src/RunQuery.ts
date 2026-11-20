import * as functions from "@distilled.cloud/convex/functions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import {
  type Callable,
  callDeclared,
  type ConvexFunctionError,
  onHost,
  unwrap,
} from "./BindingHttp.ts";
import type { Deployment } from "./Deployment.ts";
import type { Args, Failure, FunctionDeclaration, Success } from "./Function.ts";

export type RunQueryError = ConvexFunctionError | functions.QueryError;

/**
 * Run a query: a declared one, typed by its declaration, or any public
 * query by path, such as `messages:list`, with Convex JSON values.
 */
export interface RunQueryClient {
  <F extends Callable<"query">>(
    fn: F,
    args: Args<F>,
  ): Effect.Effect<Success<F>, Failure<F> | RunQueryError | Schema.SchemaError, RuntimeContext>;
  <A = unknown>(
    path: string,
    args?: Record<string, unknown>,
  ): Effect.Effect<A, RunQueryError, RuntimeContext>;
}

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
 *   const run = yield* Convex.RunQuery(Backend);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const result = yield* run("messages:list");
 *       return yield* HttpServerResponse.json(result);
 *     }),
 *   };
 * }).pipe(Effect.provide(Convex.RunQueryHttp));
 * ```
 *
 * @binding
 * @product Functions
 */
export interface RunQuery extends Binding.Service<
  RunQuery,
  "Convex.RunQuery",
  (deployment: Deployment) => Effect.Effect<RunQueryClient>
> {}

export const RunQuery = Binding.Service<RunQuery>("Convex.RunQuery");

/** Implementation over Convex's public HTTP API, usable from any host. */
export const RunQueryHttp = Layer.effect(
  RunQuery,
  Effect.succeed(
    Effect.fn(function* (deployment: Deployment) {
      const on = onHost(yield* deployment.url);
      const send = (path: string, args: Record<string, unknown>) =>
        functions.query({ path, args, format: "json" });
      const client = (target: string | FunctionDeclaration, args: Record<string, unknown> = {}) =>
        typeof target === "string"
          ? send(target, args).pipe(
              Effect.flatMap((response) => unwrap(target, response)),
              on,
            )
          : callDeclared(target, args, (encoded) => send(target.path, encoded)).pipe(on);
      return client as RunQueryClient;
    }),
  ),
);
