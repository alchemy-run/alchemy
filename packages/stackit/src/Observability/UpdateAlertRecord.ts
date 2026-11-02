import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface UpdateAlertRecordRequest extends Omit<
  observability.UpdateAlertRecordRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `updateAlertRecord`: replace one recording rule's
 * expression and labels.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link UpdateAlertRecordHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * If an `AlertGroup` resource declares this group, its next reconcile overwrites what
 * this binding changed.
 *
 * ### Updating a Recording Rule
 * **Example:** Change an expression from a Cloudflare Worker
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
 *     const updateAlertRecord =
 *       yield* Stackit.Observability.UpdateAlertRecord(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* updateAlertRecord({
 *           groupName: "orders",
 *           alertRecord: "job:latency:avg",
 *           expr: "max(latency_seconds) by (job)",
 *         });
 *         return yield* HttpServerResponse.json({ records: live.data.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.UpdateAlertRecordHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface UpdateAlertRecord extends Binding.Service<
  UpdateAlertRecord,
  "Stackit.Observability.UpdateAlertRecord",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: UpdateAlertRecordRequest,
    ) => Effect.Effect<
      observability.AlertRecordsResponse,
      observability.UpdateAlertRecordError,
      RuntimeContext
    >
  >
> {}

export const UpdateAlertRecord = Binding.Service<UpdateAlertRecord>(
  "Stackit.Observability.UpdateAlertRecord",
);
