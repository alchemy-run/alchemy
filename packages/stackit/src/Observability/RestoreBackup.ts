import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface RestoreBackupRequest extends Omit<
  observability.RestoreBackupRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `restoreBackup`: restore a part of an instance's
 * configuration from a backup.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link RestoreBackupHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * A restore overwrites the current configuration of the target with the backup's.
 * `restoreTarget` is one of `alertConfig`, `alertRules`, `scrapeConfig` and `grafana`.
 *
 * `backupDate` is a value `ListBackups` returned; the date in the example only shows
 * the call.
 *
 * ### Restoring a Backup
 * **Example:** Restore the alert rules from a Cloudflare Worker
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
 *     const restoreBackup = yield* Stackit.Observability.RestoreBackup(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* restoreBackup({ backupDate: "2026-11-01T02:00:00Z", restoreTarget: "alertRules" });
 *         return yield* HttpServerResponse.json({ message: live.message });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.RestoreBackupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface RestoreBackup extends Binding.Service<
  RestoreBackup,
  "Stackit.Observability.RestoreBackup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: RestoreBackupRequest,
    ) => Effect.Effect<observability.Message, observability.RestoreBackupError, RuntimeContext>
  >
> {}

export const RestoreBackup = Binding.Service<RestoreBackup>("Stackit.Observability.RestoreBackup");
