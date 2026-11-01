import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListBackupRetentionsRequest extends Omit<
  observability.ListBackupRetentionsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listBackupRetentions`: read how long an instance
 * keeps each kind of backup.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListBackupRetentionsHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * ### Reading Backup Retention
 * **Example:** Read the retention from a Cloudflare Worker
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
 *     const listBackupRetentions =
 *       yield* Stackit.Observability.ListBackupRetentions(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listBackupRetentions();
 *         return yield* HttpServerResponse.json({
 *           alertRules: live.alertRulesBackupRetention,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListBackupRetentionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListBackupRetentions extends Binding.Service<
  ListBackupRetentions,
  "Stackit.Observability.ListBackupRetentions",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListBackupRetentionsRequest,
    ) => Effect.Effect<
      observability.BackupRetentionResponse,
      observability.ListBackupRetentionsError,
      RuntimeContext
    >
  >
> {}

export const ListBackupRetentions = Binding.Service<ListBackupRetentions>(
  "Stackit.Observability.ListBackupRetentions",
);
