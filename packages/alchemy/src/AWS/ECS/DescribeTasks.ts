import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

export interface DescribeTasksRequest extends Omit<
  ECS.DescribeTasksRequest,
  "cluster"
> {}

/** @binding */
export interface DescribeTasks extends Binding.Service<
  DescribeTasks,
  "AWS.ECS.DescribeTasks",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: DescribeTasksRequest,
    ) => Effect.Effect<ECS.DescribeTasksResponse, ECS.DescribeTasksError>
  >
> {}
export const DescribeTasks = Binding.Service<DescribeTasks>(
  "AWS.ECS.DescribeTasks",
);
