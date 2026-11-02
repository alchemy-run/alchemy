import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListAlertGroupsRequest extends Omit<
  observability.ListAlertgroupsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `listAlertgroups`: list an instance's alert
 * groups.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListAlertGroupsHttp}. The instance's project and id are injected into
 * each request. A foreign host signs with a service account key Alchemy creates for
 * it.
 *
 * Access: a custom role with `argus.instance.get`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. STACKIT binds roles on projects at the narrowest, so it reads every
 * Observability instance in that project.
 *
 * ### Listing Groups
 * **Example:** List the group names from a Cloudflare Worker
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
 *     const listAlertGroups = yield* Stackit.Observability.ListAlertGroups(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* listAlertGroups();
 *         return yield* HttpServerResponse.json({
 *           groups: live.data.map((group) => group.name),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.ListAlertGroupsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface ListAlertGroups extends Binding.Service<
  ListAlertGroups,
  "Stackit.Observability.ListAlertGroups",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request?: ListAlertGroupsRequest,
    ) => Effect.Effect<
      observability.AlertGroupsResponse,
      observability.ListAlertgroupsError,
      RuntimeContext
    >
  >
> {}

export const ListAlertGroups = Binding.Service<ListAlertGroups>(
  "Stackit.Observability.ListAlertGroups",
);
