import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";
import type { Task } from "./Task.ts";

export interface RunTaskRequest extends Omit<
  ECS.RunTaskRequest,
  "cluster" | "taskDefinition"
> {}

/**
 * Runtime binding for `ecs:RunTask`.
 *
 * Bind this operation to a `Cluster` and `Task` inside a function runtime to
 * get a callable that starts a one-shot Fargate task from the bound task
 * definition. The cluster and task definition ARNs are injected automatically;
 * the host is granted `ecs:RunTask` on the task definition plus `iam:PassRole`
 * on the task and execution roles.
 * @binding
 * @section Running Tasks
 * @example Run a One-Shot Fargate Task
 * ```typescript
 * const runTask = yield* AWS.ECS.RunTask(cluster, task);
 *
 * const response = yield* runTask({
 *   launchType: "FARGATE",
 *   networkConfiguration: {
 *     awsvpcConfiguration: {
 *       subnets: [subnetId],
 *       securityGroups: [securityGroupId],
 *       assignPublicIp: "ENABLED",
 *     },
 *   },
 * });
 * const taskArn = response.tasks?.[0]?.taskArn;
 * ```
 */
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
