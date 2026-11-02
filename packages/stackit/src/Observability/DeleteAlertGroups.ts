import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteAlertGroupsRequest extends Omit<
  observability.DeleteAlertgroupsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `deleteAlertgroups`: remove several alert groups
 * in one call.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link DeleteAlertGroupsHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * If an `AlertGroup` resource declares one of these groups, its next reconcile creates
 * it again.
 *
 * ### Removing Groups
 * **Example:** Remove groups from a Cloudflare Worker
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
 *     const deleteAlertGroups =
 *       yield* Stackit.Observability.DeleteAlertGroups(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* deleteAlertGroups({ groupName: ["orders", "billing"] });
 *         return yield* HttpServerResponse.json({ groups: live.data.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.DeleteAlertGroupsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface DeleteAlertGroups extends Binding.Service<
  DeleteAlertGroups,
  "Stackit.Observability.DeleteAlertGroups",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteAlertGroupsRequest,
    ) => Effect.Effect<
      observability.AlertGroupsResponse,
      observability.DeleteAlertgroupsError,
      RuntimeContext
    >
  >
> {}

export const DeleteAlertGroups = Binding.Service<DeleteAlertGroups>(
  "Stackit.Observability.DeleteAlertGroups",
);
