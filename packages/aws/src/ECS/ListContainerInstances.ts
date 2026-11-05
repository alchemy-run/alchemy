import * as ECS from "@distilled.cloud/aws/ecs";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeEcsClusterHttpBinding } from "./BindingHttp.ts";
import type { Cluster } from "./Cluster.ts";

export interface ListContainerInstancesRequest extends Omit<
  ECS.ListContainerInstancesRequest,
  "cluster"
> {}

/**
 * Runtime binding for `ecs:ListContainerInstances`.
 *
 * Bind this operation to a `Cluster` inside a function runtime to get a
 * callable that lists container-instance ARNs registered to the bound
 * cluster (EC2/EXTERNAL launch types). The cluster ARN is injected
 * automatically and the host is granted `ecs:ListContainerInstances` on the
 * cluster.
 * ### Container Instances
 * **Example:** List ACTIVE Container Instances
 * ```typescript
 * const listContainerInstances = yield* AWS.ECS.ListContainerInstances(cluster);
 *
 * const response = yield* listContainerInstances({ status: "ACTIVE" });
 * const instanceArns = response.containerInstanceArns ?? [];
 * ```
 *
 * @binding
 */
export interface ListContainerInstances extends Binding.Service<
  ListContainerInstances,
  "AWS.ECS.ListContainerInstances",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: ListContainerInstancesRequest,
    ) => Effect.Effect<ECS.ListContainerInstancesResponse, ECS.ListContainerInstancesError>
  >
> {}
export const ListContainerInstances = Binding.Service<ListContainerInstances>(
  "AWS.ECS.ListContainerInstances",
);

export const ListContainerInstancesHttp = Layer.effect(
  ListContainerInstances,
  makeEcsClusterHttpBinding({
    tag: "AWS.ECS.ListContainerInstances",
    operation: ECS.listContainerInstances,
    actions: ["ecs:ListContainerInstances"],
    // `ecs:ListContainerInstances` authorizes against the cluster.
    resources: ["cluster"],
  }),
);
