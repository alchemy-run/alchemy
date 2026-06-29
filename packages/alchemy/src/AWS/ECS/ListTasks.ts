import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

export interface ListTasksRequest extends Omit<
  ECS.ListTasksRequest,
  "cluster"
> {}

/** @binding */
export interface ListTasks extends Binding.Service<
  ListTasks,
  "AWS.ECS.ListTasks",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: ListTasksRequest,
    ) => Effect.Effect<ECS.ListTasksResponse, ECS.ListTasksError>
  >
> {}
export const ListTasks = Binding.Service<ListTasks>("AWS.ECS.ListTasks");
