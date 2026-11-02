import type * as workflows from "@distilled.cloud/stackit/workflows";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListInstancesRequest extends Omit<
  workflows.ListInstancesRequest,
  "projectId" | "regionId"
> {}

/**
 * Runtime binding for STACKIT Workflows `listInstances`: list every Workflows instance in the project and region of the bound one, including instances this stack doesn't own.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and provide
 * {@link ListInstancesHttp}. The instance's project and region are injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `workflows.instance.list`, the permission the API names for this operation, on the project holding the instance. STACKIT binds roles on an organization, folder or project only, so the grant reaches every Workflows instance in that project.
 *
 * ### Listing Instances
 * **Example:** List the instances from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Airflow = Stackit.Workflows.Instance("Airflow", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const airflow = yield* Airflow;
 *     const listInstances = yield* Stackit.Workflows.ListInstances(airflow);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { instances } = yield* listInstances({});
 *         return yield* HttpServerResponse.json(instances.map((instance) => instance.displayName));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Workflows.ListInstancesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface ListInstances extends Binding.Service<
  ListInstances,
  "Stackit.Workflows.ListInstances",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListInstancesRequest,
    ) => Effect.Effect<
      workflows.ListInstancesResponse,
      workflows.ListInstancesError,
      RuntimeContext
    >
  >
> {}

export const ListInstances = Binding.Service<ListInstances>("Stackit.Workflows.ListInstances");
