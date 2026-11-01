import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetAlertConfigRequest extends Omit<
  observability.GetAlertConfigsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `getAlertConfigs`: read an instance's whole
 * Alertmanager configuration.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetAlertConfigHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * The response holds secrets, such as webhook URLs and API keys, as `Redacted` values.
 * Keep them out of logs and responses.
 *
 * ### Reading the Alert Configuration
 * **Example:** Read the receiver names from a Cloudflare Worker
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
 *     const getAlertConfig = yield* Stackit.Observability.GetAlertConfig(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getAlertConfig();
 *         return yield* HttpServerResponse.json({
 *           receivers: live.data.receivers.map((receiver) => receiver.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.GetAlertConfigHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface GetAlertConfig extends Binding.Service<
  GetAlertConfig,
  "Stackit.Observability.GetAlertConfig",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: GetAlertConfigRequest,
    ) => Effect.Effect<
      observability.GetAlertConfigsResponse,
      observability.GetAlertConfigsError,
      RuntimeContext
    >
  >
> {}

export const GetAlertConfig = Binding.Service<GetAlertConfig>(
  "Stackit.Observability.GetAlertConfig",
);
