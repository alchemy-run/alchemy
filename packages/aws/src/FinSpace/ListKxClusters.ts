import type * as SVC from "@distilled.cloud/aws/finspace";
import * as finspace from "@distilled.cloud/aws/finspace";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:ListKxClusters` — lists the kdb clusters of the bound environment, optionally filtered by cluster type.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.ListKxClustersHttp)`.
 * ### Monitoring Clusters
 * **Example:** List HDB Clusters
 * ```typescript
 * const listClusters = yield* AWS.FinSpace.ListKxClusters(kdb);
 *
 * const { kxClusterSummaries } = yield* listClusters({ clusterType: "HDB" });
 * ```
 *
 * @binding
 */
export interface ListKxClusters extends Binding.Service<
  ListKxClusters,
  "AWS.FinSpace.ListKxClusters",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListKxClustersRequest, "environmentId">,
    ) => Effect.Effect<SVC.ListKxClustersResponse, SVC.ListKxClustersError>
  >
> {}
export const ListKxClusters = Binding.Service<ListKxClusters>("AWS.FinSpace.ListKxClusters");

export const ListKxClustersHttp = Layer.effect(
  ListKxClusters,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.ListKxClusters",
    operation: finspace.listKxClusters,
    actions: ["finspace:ListKxClusters"],
  }),
);
