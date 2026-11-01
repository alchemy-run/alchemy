import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListAlertRecordsRequest extends Omit<
  observability.ListAlertRecordsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listAlertRecords`: list a group's recording
 * rules.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListAlertRecordsHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * ### Listing Recording Rules
 * **Example:** List the recording rules from a Cloudflare Worker
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
 *     const listAlertRecords = yield* Stackit.Observability.ListAlertRecords(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listAlertRecords({ groupName: "orders" });
 *         return yield* HttpServerResponse.json({
 *           records: live.data.map((record) => record.record),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListAlertRecordsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListAlertRecords extends Binding.Service<
  ListAlertRecords,
  "Stackit.Observability.ListAlertRecords",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListAlertRecordsRequest,
    ) => Effect.Effect<
      observability.AlertRecordsResponse,
      observability.ListAlertRecordsError,
      RuntimeContext
    >
  >
> {}

export const ListAlertRecords = Binding.Service<ListAlertRecords>(
  "Stackit.Observability.ListAlertRecords",
);
