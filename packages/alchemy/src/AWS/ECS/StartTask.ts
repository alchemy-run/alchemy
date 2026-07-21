import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";
import type { Task } from "./Task.ts";

export interface StartTaskRequest extends Omit<
  ECS.StartTaskRequest,
  "cluster" | "taskDefinition"
> {}

/**
 * Runtime binding for `ecs:StartTask`.
 *
 * Bind this operation to a `Cluster` and `Task` inside a function runtime to
 * get a callable that places the bound task definition on specific container
 * instances (EC2/EXTERNAL launch types — unlike `RunTask`, which lets ECS
 * pick placement). The cluster and task definition ARNs are injected
 * automatically; the host is granted `ecs:StartTask` on the task definition
 * plus `iam:PassRole` on the task and execution roles.
 * @binding
 * @section Running Tasks
 * @example Start a Task on a Specific Container Instance
 * ```typescript
 * const startTask = yield* AWS.ECS.StartTask(cluster, task);
 *
 * const response = yield* startTask({
 *   containerInstances: [containerInstanceArn],
 *   startedBy: "placement-controller",
 * });
 * const taskArn = response.tasks?.[0]?.taskArn;
 * ```
 */
export interface StartTask extends Binding.Service<
  StartTask,
  "AWS.ECS.StartTask",
  (
    cluster: Cluster,
    task: Task,
  ) => Effect.Effect<
    (
      request: StartTaskRequest,
    ) => Effect.Effect<ECS.StartTaskResponse, ECS.StartTaskError>
  >
> {}
export const StartTask = Binding.Service<StartTask>("AWS.ECS.StartTask");
