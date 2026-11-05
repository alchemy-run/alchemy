import * as dax from "@distilled.cloud/aws/dax";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDaxAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `DescribeClusters` operation (IAM action
 * `dax:DescribeClusters`).
 *
 * Lists the account's DAX clusters (optionally filtered by name) with node
 * status, endpoints and configuration embedded — the building block of
 * cluster-health monitoring and node-reboot automation. Provide the
 * implementation with `Effect.provide(AWS.DAX.DescribeClustersHttp)`.
 * ### Monitoring Clusters
 * **Example:** Check a Cluster's Node Health
 * ```typescript
 * const describeClusters = yield* DAX.DescribeClusters();
 *
 * const page = yield* describeClusters({ ClusterNames: [clusterName] });
 * const available = page.Clusters?.[0]?.Nodes?.filter(
 *   (node) => node.NodeStatus === "available",
 * );
 * ```
 *
 * @binding
 */
export interface DescribeClusters extends Binding.Service<
  DescribeClusters,
  "AWS.DAX.DescribeClusters",
  () => Effect.Effect<
    (
      request?: dax.DescribeClustersRequest,
    ) => Effect.Effect<dax.DescribeClustersResponse, dax.DescribeClustersError>
  >
> {}
export const DescribeClusters = Binding.Service<DescribeClusters>("AWS.DAX.DescribeClusters");

export const DescribeClustersHttp = Layer.effect(
  DescribeClusters,
  makeDaxAccountHttpBinding({
    tag: "AWS.DAX.DescribeClusters",
    operation: dax.describeClusters,
    actions: ["dax:DescribeClusters"],
  }),
);
