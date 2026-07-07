import * as ECS from "@distilled.cloud/aws/ecs";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Task } from "./Task.ts";
import type { Cluster } from "./Cluster.ts";

export interface RunTaskRequest extends Omit<
  ECS.RunTaskRequest,
  "cluster" | "taskDefinition"
> {}

/** @binding */
export interface RunTask extends Binding.Service<
  RunTask,
  "AWS.ECS.RunTask",
  (
    cluster: Cluster,
    task: Task,
  ) => Effect.Effect<
    (
      request: RunTaskRequest,
    ) => Effect.Effect<ECS.RunTaskResponse, ECS.RunTaskError>
  >
> {}
export const RunTask = Binding.Service<RunTask>("AWS.ECS.RunTask");
