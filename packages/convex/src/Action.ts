import * as functions from "@distilled.cloud/convex/functions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type ConvexFunctionError, onHost, unwrap } from "./BindingHttp.ts";
import type { Deployment } from "./Deployment.ts";

export type ActionError = ConvexFunctionError | functions.ActionError;

/** Run an action by path, such as `messages:ping`. */
export type ActionClient = <A = unknown>(
  path: string,
  args?: Record<string, unknown>,
) => Effect.Effect<A, ActionError, RuntimeContext>;

/**
 * Run a public Convex action from a Worker, Lambda or other host.
 *
 * It needs no credentials and grants nothing: the host gets the deployment's
 * URL. A function that throws fails with `ConvexFunctionError`. Values use
 * Convex's JSON format, so `Int64` and `Bytes` arrive as tagged objects.
 *
 * ### Calling a Function
 * **Example:** Run an action in a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const run = yield* Convex.Action(Backend);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const result = yield* run("messages:ping", { n: 41 });
 *       return yield* HttpServerResponse.json(result);
 *     }),
 *   };
 * }).pipe(Effect.provide(Convex.ActionHttp));
 * ```
 *
 * @binding
 * @product Functions
 */
export interface Action extends Binding.Service<
  Action,
  "Convex.Action",
  (deployment: Deployment) => Effect.Effect<ActionClient>
> {}

export const Action = Binding.Service<Action>("Convex.Action");

/** Implementation over Convex's public HTTP API, usable from any host. */
export const ActionHttp = Layer.effect(
  Action,
  Effect.succeed(
    Effect.fn(function* (deployment: Deployment) {
      const on = onHost(yield* deployment.url);
      const client: ActionClient = <A = unknown>(
        path: string,
        args: Record<string, unknown> = {},
      ) =>
        functions.action({ path, args, format: "json" }).pipe(
          Effect.flatMap((response) => unwrap<A>(path, response)),
          on,
        );
      return client;
    }),
  ),
);
