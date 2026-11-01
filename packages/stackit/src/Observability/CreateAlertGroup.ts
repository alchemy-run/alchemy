import type * as observability from "@distilled.cloud/stackit/observability";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface CreateAlertGroupRequest extends Omit<
  observability.CreateAlertgroupsRequest,
  "projectId" | "instanceId"
> {}

/**
 * Runtime binding for Observability `createAlertgroups`: add an alert group to an
 * instance.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link CreateAlertGroupHttp}. The instance's project and id are injected
 * into each request. A foreign host signs with a service account key Alchemy creates
 * for it.
 *
 * Access: a custom role with `argus.instance.update`, the permission the API's
 * `x-stackit-authorization` names for this operation, bound on the project holding the
 * instance. It is the only write permission this API has, and STACKIT binds roles on
 * projects at the narrowest, so the host can change the whole configuration of every
 * Observability instance in that project.
 *
 * ### Creating a Group
 * **Example:** Create a group from a Cloudflare Worker
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
 *     const createAlertGroup = yield* Stackit.Observability.CreateAlertGroup(metrics);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* createAlertGroup({
 *           name: "orders",
 *           rules: [{ alert: "HighLatency", expr: "latency_seconds > 2", for: "5m" }],
 *         });
 *         return yield* HttpServerResponse.json({ groups: live.data.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.CreateAlertGroupHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface CreateAlertGroup extends Binding.Service<
  CreateAlertGroup,
  "Stackit.Observability.CreateAlertGroup",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: CreateAlertGroupRequest,
    ) => Effect.Effect<
      observability.AlertGroupsResponse,
      observability.CreateAlertgroupsError,
      RuntimeContext
    >
  >
> {}

export const CreateAlertGroup = Binding.Service<CreateAlertGroup>(
  "Stackit.Observability.CreateAlertGroup",
);
