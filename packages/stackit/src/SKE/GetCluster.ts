import type * as ske from "@distilled.cloud/stackit/ske";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Cluster } from "./Cluster.ts";

export interface GetClusterRequest extends Omit<
  ske.GetClusterRequest,
  "projectId" | "region" | "clusterName"
> {}

/**
 * Runtime binding for SKE `getCluster`: read a cluster's spec and status, such
 * as whether it is healthy or hibernated, and when its versions expire.
 *
 * Bind this operation to a {@link Cluster} in a Function/Worker init phase and
 * provide {@link GetClusterHttp}. The cluster's project, region and name are
 * injected into each request. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ske.cluster.get` on the project holding
 * the cluster, so it reaches every cluster in that project: STACKIT binds roles
 * on projects, folders and organizations, not on a single cluster. The deployer
 * needs `iam.role.add` on that scope to define the role.
 *

 * ### Reading the Cluster
 * **Example:** Report the cluster's state from a Cloudflare Worker
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
 *     const getCluster = yield* Stackit.SKE.GetCluster(yield* Workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getCluster();
 *         return yield* HttpServerResponse.json({ state: live.status?.aggregated });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SKE.GetClusterHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Kubernetes Engine
 * @category SKE
 */
export interface GetCluster extends Binding.Service<
  GetCluster,
  "Stackit.SKE.GetCluster",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (request?: GetClusterRequest) => Effect.Effect<ske.Cluster, ske.GetClusterError, RuntimeContext>
  >
> {}

export const GetCluster = Binding.Service<GetCluster>("Stackit.SKE.GetCluster");
