import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetAlertRecordRequest extends Omit<
  observability.GetAlertRecordRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `getAlertRecord`: read one recording rule of a
 * group.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetAlertRecordHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * ### Reading a Recording Rule
 * **Example:** Read a recording rule from a Cloudflare Worker
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
 *     const getAlertRecord = yield* Stackit.Observability.GetAlertRecord(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getAlertRecord({ groupName: "orders", alertRecord: "job:latency:avg" });
 *         return yield* HttpServerResponse.json({ expr: live.data.expr });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.GetAlertRecordHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface GetAlertRecord extends Binding.Service<
  GetAlertRecord,
  "Stackit.Observability.GetAlertRecord",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetAlertRecordRequest,
    ) => Effect.Effect<
      observability.AlertRecordResponse,
      observability.GetAlertRecordError,
      RuntimeContext
    >
  >
> {}

export const GetAlertRecord = Binding.Service<GetAlertRecord>(
  "Stackit.Observability.GetAlertRecord",
);
