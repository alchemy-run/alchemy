import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetAlertConfigReceiverRequest extends Omit<
  observability.GetAlertConfigReceiverRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `getAlertConfigReceiver`: read one alert receiver.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetAlertConfigReceiverHttp}. The instance's project and id are
 * injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * The response holds secrets, such as webhook URLs and API keys, as `Redacted` values.
 * Keep them out of logs and responses.
 *
 * ### Reading a Receiver
 * **Example:** Read a receiver from a Cloudflare Worker
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
 *     const getAlertConfigReceiver =
 *       yield* Stackit.Observability.GetAlertConfigReceiver(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getAlertConfigReceiver({ receiver: "on-call" });
 *         return yield* HttpServerResponse.json({
 *           webhooks: live.data.webHookConfigs?.length ?? 0,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.GetAlertConfigReceiverHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface GetAlertConfigReceiver extends Binding.Service<
  GetAlertConfigReceiver,
  "Stackit.Observability.GetAlertConfigReceiver",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetAlertConfigReceiverRequest,
    ) => Effect.Effect<
      observability.Receiver,
      observability.GetAlertConfigReceiverError,
      RuntimeContext
    >
  >
> {}

export const GetAlertConfigReceiver = Binding.Service<GetAlertConfigReceiver>(
  "Stackit.Observability.GetAlertConfigReceiver",
);
