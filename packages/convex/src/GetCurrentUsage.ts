import * as deploymentApi from "@distilled.cloud/convex/deployment";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { hostKey, onHost } from "./BindingHttp.ts";
import type { Deployment } from "./Deployment.ts";

/** Read each usage metric for the current day and month, in UTC. */
export type GetCurrentUsageClient = () => Effect.Effect<
  deploymentApi.GetCurrentUsageResponse,
  deploymentApi.GetCurrentUsageError,
  RuntimeContext
>;

/**
 * Read a Convex deployment's current usage from a Worker, Lambda or other host.
 *
 * The host gets a deploy key that can only do `deployment:usage:view` on this
 * deployment. Convex marks this API as beta.
 *
 * ### Reading Usage
 * **Example:** Report function calls this month
 * ```typescript
 * Effect.gen(function* () {
 *   const usage = yield* Convex.GetCurrentUsage(Backend);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const { metrics } = yield* usage();
 *       return yield* HttpServerResponse.json(metrics.functionCalls);
 *     }),
 *   };
 * }).pipe(Effect.provide(Convex.GetCurrentUsageHttp));
 * ```
 *
 * @binding
 * @product Deployment
 */
export interface GetCurrentUsage extends Binding.Service<
  GetCurrentUsage,
  "Convex.GetCurrentUsage",
  (deployment: Deployment) => Effect.Effect<GetCurrentUsageClient>
> {}

export const GetCurrentUsage = Binding.Service<GetCurrentUsage>("Convex.GetCurrentUsage");

/** Implementation over the Deployment API, usable from any host. */
export const GetCurrentUsageHttp = Layer.effect(
  GetCurrentUsage,
  Effect.succeed(
    Effect.fn(function* (deployment: Deployment) {
      const key = yield* hostKey(deployment, "Usage", ["deployment:usage:view"]);
      const on = onHost(yield* deployment.url, key);
      const client: GetCurrentUsageClient = () => deploymentApi.getCurrentUsage({}).pipe(on);
      return client;
    }),
  ),
);
