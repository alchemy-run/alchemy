import type * as ske from "@distilled.cloud/stackit/ske";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Cluster } from "./Cluster.ts";

export interface TriggerMaintenanceRequest extends Omit<
  ske.TriggerMaintenanceRequest,
  "projectId" | "region" | "clusterName"
> {}

/**
 * Runtime binding for SKE `triggerMaintenance`: run a cluster's maintenance now
 * rather than in its window. The `autoUpdate` of the cluster's `maintenance`
 * decides what it updates, and it runs asynchronously: follow it with
 * `Stackit.SKE.GetCluster`.
 *
 * Bind this operation to a {@link Cluster} in a Function/Worker init phase and
 * provide {@link TriggerMaintenanceHttp}. The cluster's project, region and
 * name are injected into each request. It works on any host. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ske.cluster.maintain` on the project
 * holding the cluster, so it reaches every cluster in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single cluster.
 * The deployer needs `iam.role.add` on that scope to define the role.
 *

 * ### Operating the Cluster
 * **Example:** Run maintenance from an operator Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Workers = Stackit.SKE.Cluster("Workers", {
 *   nodepools: [
 *     {
 *       name: "workers",
 *       machineType: "c1.2",
 *       availabilityZones: ["eu01-1"],
 *       minimum: 1,
 *       maximum: 3,
 *     },
 *   ],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const maintain = yield* Stackit.SKE.TriggerMaintenance(yield* Workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* maintain();
 *         return HttpServerResponse.text("maintaining");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SKE.TriggerMaintenanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Kubernetes Engine
 * @category SKE
 */
export interface TriggerMaintenance extends Binding.Service<
  TriggerMaintenance,
  "Stackit.SKE.TriggerMaintenance",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: TriggerMaintenanceRequest,
    ) => Effect.Effect<ske.TriggerMaintenanceResponse, ske.TriggerMaintenanceError, RuntimeContext>
  >
> {}

export const TriggerMaintenance = Binding.Service<TriggerMaintenance>(
  "Stackit.SKE.TriggerMaintenance",
);
