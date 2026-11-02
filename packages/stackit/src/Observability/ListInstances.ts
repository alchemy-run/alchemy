import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListInstancesRequest extends Omit<
  observability.ListInstancesRequest,
  "projectId"
> {}

/**
 * Runtime binding for Observability `listInstances`: list the Observability instances
 * in the project of the bound instance.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListInstancesHttp}. The instance's project is injected into each
 * request. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role with `argus.instance.list`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest.
 *
 * ### Listing Instances
 * **Example:** List the instances from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const metrics = yield* Metrics;
 *     const listInstances = yield* Stackit.Observability.ListInstances(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listInstances();
 *         return yield* HttpServerResponse.json({
 *           names: live.instances.map((instance) => instance.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListInstancesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListInstances extends Binding.Service<
  ListInstances,
  "Stackit.Observability.ListInstances",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListInstancesRequest,
    ) => Effect.Effect<
      observability.ListInstancesResponse,
      observability.ListInstancesError,
      RuntimeContext
    >
  >
> {}

export const ListInstances = Binding.Service<ListInstances>("Stackit.Observability.ListInstances");
