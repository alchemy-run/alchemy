import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListBackupsRequest extends Omit<
  observability.ListBackupsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listBackups`: list an instance's backups by
 * target.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListBackupsHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * ### Listing Backups
 * **Example:** List the alert rule backups from a Cloudflare Worker
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
 *     const listBackups = yield* Stackit.Observability.ListBackups(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listBackups({ backupTarget: ["alertRules"] });
 *         return yield* HttpServerResponse.json({ backups: live.alertRulesBackups });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListBackupsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListBackups extends Binding.Service<
  ListBackups,
  "Stackit.Observability.ListBackups",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListBackupsRequest,
    ) => Effect.Effect<observability.BackupResponse, observability.ListBackupsError, RuntimeContext>
  >
> {}

export const ListBackups = Binding.Service<ListBackups>("Stackit.Observability.ListBackups");
