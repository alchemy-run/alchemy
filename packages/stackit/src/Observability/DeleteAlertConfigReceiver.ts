import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteAlertConfigReceiverRequest extends Omit<
  observability.DeleteAlertConfigReceiverRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `deleteAlertConfigReceiver`: remove one alert
 * receiver.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link DeleteAlertConfigReceiverHttp}. The instance's project and id are
 * injected into each request. A foreign host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * If an `AlertConfig` resource declares this receiver, its next reconcile creates it
 * again.
 *
 * The response holds secrets, such as webhook URLs and API keys, as `Redacted` values.
 * Keep them out of logs and responses.
 *
 * ### Removing a Receiver
 * **Example:** Remove a receiver from a Cloudflare Worker
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
 *     const deleteAlertConfigReceiver =
 *       yield* Stackit.Observability.DeleteAlertConfigReceiver(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* deleteAlertConfigReceiver({ receiver: "on-call" });
 *         return yield* HttpServerResponse.json({ receivers: live.data.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.DeleteAlertConfigReceiverHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface DeleteAlertConfigReceiver extends Binding.Service<
  DeleteAlertConfigReceiver,
  "Stackit.Observability.DeleteAlertConfigReceiver",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteAlertConfigReceiverRequest,
    ) => Effect.Effect<
      observability.AlertConfigReceiversResponse,
      observability.DeleteAlertConfigReceiverError,
      RuntimeContext
    >
  >
> {}

export const DeleteAlertConfigReceiver = Binding.Service<DeleteAlertConfigReceiver>(
  "Stackit.Observability.DeleteAlertConfigReceiver",
);
