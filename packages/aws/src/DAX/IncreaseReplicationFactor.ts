import * as dax from "@distilled.cloud/aws/dax";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDaxClusterHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Runtime binding for the `IncreaseReplicationFactor` operation (IAM action
 * `dax:IncreaseReplicationFactor`), scoped to one {@link Cluster}.
 *
 * Adds read-replica nodes to the bound DAX cluster — the building block of
 * scale-out automation (e.g. a Lambda reacting to a CloudWatch alarm on
 * cluster CPU or cache-miss rate). Provide the implementation with
 * `Effect.provide(AWS.DAX.IncreaseReplicationFactorHttp)`.
 * ### Scaling a Cluster
 * **Example:** Scale Out to Three Nodes
 * ```typescript
 * const increaseReplicationFactor =
 *   yield* DAX.IncreaseReplicationFactor(cluster);
 *
 * const result = yield* increaseReplicationFactor({
 *   NewReplicationFactor: 3,
 * });
 * // result.Cluster?.TotalNodes → 3 (new nodes provision asynchronously)
 * ```
 *
 * @binding
 */
export interface IncreaseReplicationFactor extends Binding.Service<
  IncreaseReplicationFactor,
  "AWS.DAX.IncreaseReplicationFactor",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: Omit<dax.IncreaseReplicationFactorRequest, "ClusterName">,
    ) => Effect.Effect<dax.IncreaseReplicationFactorResponse, dax.IncreaseReplicationFactorError>
  >
> {}
export const IncreaseReplicationFactor = Binding.Service<IncreaseReplicationFactor>(
  "AWS.DAX.IncreaseReplicationFactor",
);

export const IncreaseReplicationFactorHttp = Layer.effect(
  IncreaseReplicationFactor,
  makeDaxClusterHttpBinding({
    tag: "AWS.DAX.IncreaseReplicationFactor",
    operation: dax.increaseReplicationFactor,
    actions: ["dax:IncreaseReplicationFactor"],
  }),
);
