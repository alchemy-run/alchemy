import type * as modelExperiments from "@distilled.cloud/stackit/model_experiments";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  modelExperiments.GetInstanceRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for `getInstance`: read an instance's state, tracking URL and artifact
 * bucket. Bind it to an {@link Instance} and provide {@link GetInstanceHttp}. The instance's
 * project, region and id are injected into each request, and the host signs with a service
 * account key Alchemy creates for it.
 *
 * Access: a custom role holding only `model-experiments.instance.get`, on the project holding
 * the instance. STACKIT binds roles on projects, folders and organizations, never on one
 * instance, so the role reaches every instance of the service in the project. The deployer
 * needs `iam.role.add` on the project to define it.
 *
 * ### Reading the Instance
 * **Example:** Read the state and tracking URL
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
 *     const binding = yield* Stackit.ModelExperiments.GetInstance(yield* Experiments);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { instance } = yield* binding();
 *         return yield* HttpServerResponse.json({ state: instance.state, url: instance.url });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelExperiments.GetInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Experiments
 * @category ModelExperiments
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "Stackit.ModelExperiments.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetInstanceRequest,
    ) => Effect.Effect<
      modelExperiments.GetInstanceResponse,
      modelExperiments.GetInstanceError,
      RuntimeContext
    >
  >
> {}

export const GetInstance = Binding.Service<GetInstance>("Stackit.ModelExperiments.GetInstance");
