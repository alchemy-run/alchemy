import type * as ske from "@distilled.cloud/stackit/ske";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Cluster } from "./Cluster.ts";

export interface TriggerReconcileRequest extends Omit<
  ske.TriggerReconcileRequest,
  "projectId" | "region" | "clusterName"
> {}

/**
 * Runtime binding for SKE `triggerReconcile`: reconcile a whole cluster now,
 * without changing its spec. It runs asynchronously: follow it with
 * `Stackit.SKE.GetCluster`.
 *
 * Bind this operation to a {@link Cluster} in a Function/Worker init phase and
 * provide {@link TriggerReconcileHttp}. The cluster's project, region and name
 * are injected into each request. It works on any host. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ske.cluster.reconcile` on the project
 * holding the cluster, so it reaches every cluster in that project: STACKIT
 * binds roles on projects, folders and organizations, not on a single cluster.
 * The deployer needs `iam.role.add` on that scope to define the role.
 *

 * ### Operating the Cluster
 * **Example:** Force a reconcile from an operator Worker
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
 *     const reconcile = yield* Stackit.SKE.TriggerReconcile(yield* Workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* reconcile();
 *         return HttpServerResponse.text("reconciling");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SKE.TriggerReconcileHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Kubernetes Engine
 * @category SKE
 */
export interface TriggerReconcile extends Binding.Service<
  TriggerReconcile,
  "Stackit.SKE.TriggerReconcile",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: TriggerReconcileRequest,
    ) => Effect.Effect<ske.TriggerReconcileResponse, ske.TriggerReconcileError, RuntimeContext>
  >
> {}

export const TriggerReconcile = Binding.Service<TriggerReconcile>("Stackit.SKE.TriggerReconcile");
