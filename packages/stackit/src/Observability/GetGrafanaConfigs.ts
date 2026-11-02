import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetGrafanaConfigsRequest extends Omit<
  observability.GetGrafanaConfigsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `getGrafanaConfigs`: read an instance's Grafana
 * settings.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetGrafanaConfigsHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * The response holds the OAuth client secret as a `Redacted` value. Keep it out of
 * logs and responses.
 *
 * ### Reading Grafana Settings
 * **Example:** Read the Grafana settings from a Cloudflare Worker
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
 *     const getGrafanaConfigs =
 *       yield* Stackit.Observability.GetGrafanaConfigs(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getGrafanaConfigs();
 *         return yield* HttpServerResponse.json({
 *           publicReadAccess: live.publicReadAccess,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.GetGrafanaConfigsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface GetGrafanaConfigs extends Binding.Service<
  GetGrafanaConfigs,
  "Stackit.Observability.GetGrafanaConfigs",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetGrafanaConfigsRequest,
    ) => Effect.Effect<
      observability.GrafanaConfigs,
      observability.GetGrafanaConfigsError,
      RuntimeContext
    >
  >
> {}

export const GetGrafanaConfigs = Binding.Service<GetGrafanaConfigs>(
  "Stackit.Observability.GetGrafanaConfigs",
);
