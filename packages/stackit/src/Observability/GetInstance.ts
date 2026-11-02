import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetInstanceRequest extends Omit<
  observability.GetInstanceRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `getInstance`: read an instance's status, plan and
 * URLs.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetInstanceHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * The instance's deprecated `instance.grafanaAdminPassword` is `Redacted`. Keep it out
 * of logs and responses.
 *
 * ### Reading the Instance
 * **Example:** Read the status from a Cloudflare Worker
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
 *     const getInstance = yield* Stackit.Observability.GetInstance(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getInstance();
 *         return yield* HttpServerResponse.json({
 *           status: live.status, grafanaUrl: live.instance.grafanaUrl,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.GetInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface GetInstance extends Binding.Service<
  GetInstance,
  "Stackit.Observability.GetInstance",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetInstanceRequest,
    ) => Effect.Effect<
      observability.GetInstanceResponse,
      observability.GetInstanceError,
      RuntimeContext
    >
  >
> {}

export const GetInstance = Binding.Service<GetInstance>("Stackit.Observability.GetInstance");
