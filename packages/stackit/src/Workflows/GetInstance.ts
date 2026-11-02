import type * as workflows from "@distilled.cloud/stackit/workflows";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  workflows.GetInstanceRequest,
  "projectId" | "regionId" | "instanceId"
> {}

/**
 * Runtime binding for STACKIT Workflows `getInstance`: read the instance's settings, URLs and status.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and provide
 * {@link GetInstanceHttp}. The instance's project, region and id are injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `workflows.instance.get`, the permission the API names for this operation, on the project holding the instance. STACKIT binds roles on an organization, folder or project only, so the grant reaches every Workflows instance in that project.
 *
 * ### Reading the Instance
 * **Example:** Read the status from a Cloudflare Worker
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
 *     const getInstance = yield* Stackit.Workflows.GetInstance(airflow);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getInstance({});
 *         return yield* HttpServerResponse.json({ status: live.status, url: live.endpoints.url });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Workflows.GetInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Workflows
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "Stackit.Workflows.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetInstanceRequest,
    ) => Effect.Effect<workflows.Instance, workflows.GetInstanceError, RuntimeContext>
  >
> {}

export const GetInstance = Binding.Service<GetInstance>("Stackit.Workflows.GetInstance");
