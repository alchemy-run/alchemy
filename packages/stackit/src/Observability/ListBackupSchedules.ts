import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListBackupSchedulesRequest extends Omit<
  observability.ListBackupSchedulesRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listBackupSchedules`: list an instance's backup
 * schedules by target.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListBackupSchedulesHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * ### Listing Backup Schedules
 * **Example:** List the alert rule schedules from a Cloudflare Worker
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
 *     const listBackupSchedules =
 *       yield* Stackit.Observability.ListBackupSchedules(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listBackupSchedules({ backupTarget: ["alertRules"] });
 *         return yield* HttpServerResponse.json({
 *           schedules: live.alertRulesBackupSchedules ?? [],
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListBackupSchedulesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListBackupSchedules extends Binding.Service<
  ListBackupSchedules,
  "Stackit.Observability.ListBackupSchedules",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListBackupSchedulesRequest,
    ) => Effect.Effect<
      observability.BackupScheduleResponse,
      observability.ListBackupSchedulesError,
      RuntimeContext
    >
  >
> {}

export const ListBackupSchedules = Binding.Service<ListBackupSchedules>(
  "Stackit.Observability.ListBackupSchedules",
);
