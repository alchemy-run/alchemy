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
import { createOnce } from "./internal/retry.ts";

export type RunMutationError = ConvexFunctionError | functions.MutationError;

/**
 * Run a mutation: a declared one, typed by its declaration, or any public
 * mutation by path, such as `messages:list`, with Convex JSON values.
 */
export interface RunMutationClient {
  <F extends Callable<"mutation">>(
    fn: F,
    args: Args<F>,
  ): Effect.Effect<Success<F>, Failure<F> | RunMutationError | Schema.SchemaError, RuntimeContext>;
  <A = unknown>(
    path: string,
    args?: Record<string, unknown>,
  ): Effect.Effect<A, RunMutationError, RuntimeContext>;
}

/**
 * Run a public Convex mutation from a Worker, Lambda or other host.
 *
 * It needs no credentials and grants nothing: the host gets the deployment's
 * URL. A function that throws fails with `ConvexFunctionError`. Values use
 * Convex's JSON format, so `Int64` and `Bytes` arrive as tagged objects.
 *
 * ### Calling a Function
 * **Example:** Run a mutation in a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const run = yield* Convex.RunMutation(Backend);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const result = yield* run("messages:add", { body: "hello" });
 *       return yield* HttpServerResponse.json(result);
 *     }),
 *   };
 * }).pipe(Effect.provide(Convex.RunMutationHttp));
 * ```
 *
 * @binding
 * @product Functions
 */
export interface RunMutation extends Binding.Service<
  RunMutation,
  "Convex.RunMutation",
  (deployment: Deployment) => Effect.Effect<RunMutationClient>
> {}

export const RunMutation = Binding.Service<RunMutation>("Convex.RunMutation");

/** Implementation over Convex's public HTTP API, usable from any host. */
export const RunMutationHttp = Layer.effect(
  RunMutation,
  Effect.succeed(
    Effect.fn(function* (deployment: Deployment) {
      const on = onHost(yield* deployment.url);
      const send = (path: string, args: Record<string, unknown>) =>
        // Not idempotent: a retry after a lost response would run it twice.
        createOnce(functions.mutation({ path, args, format: "json" }));
      const client = (target: string | FunctionDeclaration, args: Record<string, unknown> = {}) =>
        typeof target === "string"
          ? send(target, args).pipe(
              Effect.flatMap((response) => unwrap(target, response)),
              on,
            )
          : callDeclared(target, args, (encoded) => send(target.path, encoded)).pipe(on);
      return client as RunMutationClient;
    }),
  ),
);
