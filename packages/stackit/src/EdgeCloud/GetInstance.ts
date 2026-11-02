import type * as edge from "@distilled.cloud/stackit/edge";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

/**
 * Runtime binding for Edge Cloud `getInstance`: read an instance's status, plan and
 * management UI URL.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetInstanceHttp}. The instance's project, region and id are injected
 * into each request. It works on any host. A foreign host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `edge.instances.get` on the project holding the
 * instance, so it reaches every instance in that project: STACKIT binds roles on
 * projects, folders and organizations, not on a single instance. The deployer needs
 * `iam.role.add` on that scope to define the role.
 *
 * ### Reading the Instance
 * **Example:** Report the instance's status from a Cloudflare Worker
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
 *     const getInstance = yield* Stackit.EdgeCloud.GetInstance(yield* Edge);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getInstance();
 *         return yield* HttpServerResponse.json({ status: live.status });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.EdgeCloud.GetInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Edge Cloud
 * @category EdgeCloud
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "Stackit.EdgeCloud.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<() => Effect.Effect<edge.Instance, edge.GetInstanceError, RuntimeContext>>
> {}

export const GetInstance = Binding.Service<GetInstance>("Stackit.EdgeCloud.GetInstance");
