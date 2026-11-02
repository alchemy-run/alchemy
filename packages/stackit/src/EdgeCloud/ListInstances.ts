import type * as edge from "@distilled.cloud/stackit/edge";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for Edge Cloud `listInstances`: list every instance in the project
 * and region holding the bound instance, such as to report on a fleet.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListInstancesHttp}. The instance's project and region are injected
 * into each request. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `edge.instances.list` on the project holding the
 * instance, so it reaches every instance in that project: STACKIT binds roles on
 * projects, folders and organizations, not on a single instance. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Discovering Instances
 * **Example:** List the instances next to a bound one
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Edge = Stackit.EdgeCloud.Instance("Edge", {
 *   planId: "11111111-2222-3333-4444-555555555555",
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listInstances = yield* Stackit.EdgeCloud.ListInstances(yield* Edge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { instances } = yield* listInstances();
 *         return yield* HttpServerResponse.json(instances.map((item) => item.displayName));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.EdgeCloud.ListInstancesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Edge Cloud
 * @category EdgeCloud
 */
export interface ListInstances extends Binding.Service<
  ListInstances,
  "Stackit.EdgeCloud.ListInstances",
  (
    instance: Instance,
  ) => Effect.Effect<
    () => Effect.Effect<edge.InstanceList, edge.ListInstancesError, RuntimeContext>
  >
> {}

export const ListInstances = Binding.Service<ListInstances>("Stackit.EdgeCloud.ListInstances");
