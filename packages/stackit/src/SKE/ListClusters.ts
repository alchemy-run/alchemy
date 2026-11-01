import type * as ske from "@distilled.cloud/stackit/ske";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Cluster } from "./Cluster.ts";

export interface ListClustersRequest extends Omit<
  ske.ListClustersRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for SKE `listClusters`: list every cluster in the project and
 * region holding the bound cluster, such as to report on a fleet.
 *
 * Bind this operation to a {@link Cluster} in a Function/Worker init phase and
 * provide {@link ListClustersHttp}. The cluster's project and region are
 * injected into each request. It works on any host. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role holding only `ske.cluster.list` on the project holding
 * the cluster, so it reaches every cluster in that project: STACKIT binds roles
 * on projects, folders and organizations, not on a single cluster. The deployer
 * needs `iam.role.add` on that scope to define the role.
 *

 * ### Discovering Clusters
 * **Example:** List the clusters next to a bound one
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
 *     const listClusters = yield* Stackit.SKE.ListClusters(yield* Workers);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { items } = yield* listClusters();
 *         return yield* HttpServerResponse.json((items ?? []).map((item) => item.name));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SKE.ListClustersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Kubernetes Engine
 * @category SKE
 */
export interface ListClusters extends Binding.Service<
  ListClusters,
  "Stackit.SKE.ListClusters",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request?: ListClustersRequest,
    ) => Effect.Effect<ske.ListClustersResponse, ske.ListClustersError, RuntimeContext>
  >
> {}

export const ListClusters = Binding.Service<ListClusters>("Stackit.SKE.ListClusters");
