import * as functions from "@distilled.cloud/convex/functions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type ConvexFunctionError, onHost, unwrap } from "./BindingHttp.ts";
import type { Deployment } from "./Deployment.ts";
import { createOnce } from "./internal/retry.ts";

export type MutationError = ConvexFunctionError | functions.MutationError;

/** Run a mutation by path, such as `messages:add`. */
export type MutationClient = <A = unknown>(
  path: string,
  args?: Record<string, unknown>,
) => Effect.Effect<A, MutationError, RuntimeContext>;

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
 *   const run = yield* Convex.Mutation(Backend);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const result = yield* run("messages:add", { body: "hello" });
 *       return yield* HttpServerResponse.json(result);
 *     }),
 *   };
 * }).pipe(Effect.provide(Convex.MutationHttp));
 * ```
 *
 * @binding
 * @product Functions
 */
export interface Mutation extends Binding.Service<
  Mutation,
  "Convex.Mutation",
  (deployment: Deployment) => Effect.Effect<MutationClient>
> {}

export const Mutation = Binding.Service<Mutation>("Convex.Mutation");

/** Implementation over Convex's public HTTP API, usable from any host. */
export const MutationHttp = Layer.effect(
  Mutation,
  Effect.succeed(
    Effect.fn(function* (deployment: Deployment) {
      const on = onHost(yield* deployment.url);
      const client: MutationClient = <A = unknown>(
        path: string,
        args: Record<string, unknown> = {},
      ) =>
        // Not idempotent: a retry after a lost response would run it twice.
        createOnce(functions.mutation({ path, args, format: "json" })).pipe(
          Effect.flatMap((response) => unwrap<A>(path, response)),
          on,
        );
      return client;
    }),
  ),
);
