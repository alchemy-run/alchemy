import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface UpdateAlertConfigReceiverRequest extends Omit<
  observability.UpdateAlertConfigReceiverRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `updateAlertConfigReceiver`: replace one alert
 * receiver's configuration.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link UpdateAlertConfigReceiverHttp}. The instance's project and id are
 * injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * An `AlertConfig` resource writes the instance's whole alert configuration, so if one
 * manages this instance its next reconcile removes what this binding added, unless the
 * receiver's name starts with `alchemy-webhook-`.
 *
 * The response holds secrets, such as webhook URLs and API keys, as `Redacted` values.
 * Keep them out of logs and responses.
 *
 * ### Updating a Receiver
 * **Example:** Point a receiver at a new webhook from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Redacted from "effect/Redacted";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const metrics = yield* Metrics;
 *     const updateAlertConfigReceiver =
 *       yield* Stackit.Observability.UpdateAlertConfigReceiver(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* updateAlertConfigReceiver({
 *           receiver: "on-call",
 *           name: "on-call",
 *           webHookConfigs: [{ url: Redacted.make("https://hooks.example.com/alerts") }],
 *         });
 *         return yield* HttpServerResponse.json({ receivers: live.data.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.UpdateAlertConfigReceiverHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface UpdateAlertConfigReceiver extends Binding.Service<
  UpdateAlertConfigReceiver,
  "Stackit.Observability.UpdateAlertConfigReceiver",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: UpdateAlertConfigReceiverRequest,
    ) => Effect.Effect<
      observability.AlertConfigReceiversResponse,
      observability.UpdateAlertConfigReceiverError,
      RuntimeContext
    >
  >
> {}

export const UpdateAlertConfigReceiver = Binding.Service<UpdateAlertConfigReceiver>(
  "Stackit.Observability.UpdateAlertConfigReceiver",
);
