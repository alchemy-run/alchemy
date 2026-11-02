import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetLogsConfigsRequest extends Omit<
  observability.GetLogsConfigsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `getLogsConfigs`: read how long an instance keeps
 * logs.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetLogsConfigsHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * Needs a plan with logs, such as `Observability-Starter-EU01`.
 *
 * ### Reading Logs Retention
 * **Example:** Read the retention from a Cloudflare Worker
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
 *     const getLogsConfigs = yield* Stackit.Observability.GetLogsConfigs(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getLogsConfigs();
 *         return yield* HttpServerResponse.json({ retention: live.config.retention });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.GetLogsConfigsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface GetLogsConfigs extends Binding.Service<
  GetLogsConfigs,
  "Stackit.Observability.GetLogsConfigs",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetLogsConfigsRequest,
    ) => Effect.Effect<
      observability.LogsConfigResponse,
      observability.GetLogsConfigsError,
      RuntimeContext
    >
  >
> {}

export const GetLogsConfigs = Binding.Service<GetLogsConfigs>(
  "Stackit.Observability.GetLogsConfigs",
);
