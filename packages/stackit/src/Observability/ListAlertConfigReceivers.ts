import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListAlertConfigReceiversRequest extends Omit<
  observability.ListAlertConfigReceiversRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listAlertConfigReceivers`: list an instance's
 * alert receivers.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListAlertConfigReceiversHttp}. The instance's project and id are
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
 * ### Listing Receivers
 * **Example:** List the receiver names from a Cloudflare Worker
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
 *     const listAlertConfigReceivers =
 *       yield* Stackit.Observability.ListAlertConfigReceivers(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listAlertConfigReceivers();
 *         return yield* HttpServerResponse.json({
 *           receivers: live.data.map((receiver) => receiver.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListAlertConfigReceiversHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListAlertConfigReceivers extends Binding.Service<
  ListAlertConfigReceivers,
  "Stackit.Observability.ListAlertConfigReceivers",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListAlertConfigReceiversRequest,
    ) => Effect.Effect<
      observability.AlertConfigReceiversResponse,
      observability.ListAlertConfigReceiversError,
      RuntimeContext
    >
  >
> {}

export const ListAlertConfigReceivers = Binding.Service<ListAlertConfigReceivers>(
  "Stackit.Observability.ListAlertConfigReceivers",
);
