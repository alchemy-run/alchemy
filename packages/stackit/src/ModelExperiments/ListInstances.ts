import type * as modelExperiments from "@distilled.cloud/stackit/model_experiments";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListInstancesRequest extends Omit<
  modelExperiments.ListInstancesRequest,
  "projectId" | "regionId"
> {}

/**
 * Runtime binding for `listInstances`: list the Model Experiments instances of the bound
 * instance's project and region. Bind it to an {@link Instance} and provide {@link
 * ListInstancesHttp}. The project and region are injected into each request, and the host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `model-experiments.instance.list`, on the project holding
 * the instance. STACKIT binds roles on projects, folders and organizations, never on one
 * instance, so the role reaches every instance of the service in the project. The deployer
 * needs `iam.role.add` on the project to define it.
 *
 * ### Listing Instances
 * **Example:** List the instances in the project
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Experiments = Stackit.ModelExperiments.Instance("Experiments", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const binding = yield* Stackit.ModelExperiments.ListInstances(yield* Experiments);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { instances } = yield* binding();
 *         return yield* HttpServerResponse.json(instances.map((instance) => instance.name));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelExperiments.ListInstancesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Experiments
 * @category ModelExperiments
 */
export interface ListInstances extends Binding.Service<
  ListInstances,
  "Stackit.ModelExperiments.ListInstances",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListInstancesRequest,
    ) => Effect.Effect<
      modelExperiments.ListInstancesResponse,
      modelExperiments.ListInstancesError,
      RuntimeContext
    >
  >
> {}

export const ListInstances = Binding.Service<ListInstances>(
  "Stackit.ModelExperiments.ListInstances",
);
