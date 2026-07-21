import type * as ECS from "@distilled.cloud/aws/ecs";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import type { Cluster } from "./Cluster.ts";
import type { Task } from "./Task.ts";

export interface RunTaskRequest extends Omit<
  ECS.RunTaskRequest,
  "cluster" | "taskDefinition"
> {}

/**
 * Typed bind-time error raised by the task-only form `RunTask(task)` when
 * the bound task does not declare a `cluster` in its props. Either declare
 * `cluster` on the Task or pass the cluster explicitly:
 * `RunTask(cluster, task)`.
 */
export class RunTaskRequiresCluster extends Data.TaggedError(
  "RunTaskRequiresCluster",
)<{
  /** Logical id of the task the binding was given. */
  task: string;
  message: string;
}> {}

/**
 * Runtime binding for `ecs:RunTask`.
 *
 * Bind this operation to a `Task` inside a function runtime to get a
 * callable that starts a one-shot Fargate task from the bound task
 * definition. The cluster and task definition ARNs are injected
 * automatically; the host is granted `ecs:RunTask` on the task definition
 * plus `iam:PassRole` on the task and execution roles.
 *
 * The cluster is resolved from the task's declared `cluster` prop; binding
 * a task that declares no cluster fails at bind time (plan time) with
 * {@link RunTaskRequiresCluster}. Pass a `Cluster` explicitly —
 * `RunTask(cluster, task)` — to run the task definition on a different
 * cluster than the one it declares (or when the task declares none).
 * @binding
 * @section Running Tasks
 * @example Run a One-Shot Fargate Task
 * ```typescript
 * // `task` declares its home cluster: Task("Job", { cluster, ... })
 * const runTask = yield* AWS.ECS.RunTask(task).pipe(Effect.orDie);
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
 *
 * @example Run on an Explicit Cluster
 * ```typescript
 * // Overrides (or supplies) the cluster — the task definition itself is
 * // not cluster-scoped.
 * const runTask = yield* AWS.ECS.RunTask(cluster, task);
 * ```
 */
export interface RunTask extends Binding.Service<
  RunTask,
  "AWS.ECS.RunTask",
  (
    ...args: [cluster: Cluster, task: Task] | [task: Task]
  ) => Effect.Effect<
    (
      request: RunTaskRequest,
    ) => Effect.Effect<ECS.RunTaskResponse, ECS.RunTaskError>,
    RunTaskRequiresCluster
  >
> {
  /**
   * Explicit-cluster form — runs the bound task definition on `cluster`.
   * Cannot fail at bind time.
   */
  <Req = never>(
    cluster: Input<Cluster> | Effect.Effect<Cluster, never, Req>,
    task: Input<Task> | Effect.Effect<Task, never, Req>,
  ): Effect.Effect<
    (
      request: RunTaskRequest,
    ) => Effect.Effect<ECS.RunTaskResponse, ECS.RunTaskError>,
    never,
    RunTask | Req
  >;
  /**
   * Task-only form — runs on the cluster the task declares via its
   * `cluster` prop; fails at bind time with {@link RunTaskRequiresCluster}
   * when the task declares none.
   */
  <Req = never>(
    task: Input<Task> | Effect.Effect<Task, never, Req>,
  ): Effect.Effect<
    (
      request: RunTaskRequest,
    ) => Effect.Effect<ECS.RunTaskResponse, ECS.RunTaskError>,
    RunTaskRequiresCluster,
    RunTask | Req
  >;
}
export const RunTask = Binding.Service<RunTask>("AWS.ECS.RunTask");
