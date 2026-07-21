import type * as ECS from "@distilled.cloud/aws/ecs";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Input } from "../../Input.ts";
import type { Cluster } from "./Cluster.ts";
import type { Task } from "./Task.ts";

export interface StartTaskRequest extends Omit<
  ECS.StartTaskRequest,
  "cluster" | "taskDefinition"
> {}

/**
 * Typed bind-time error raised by the task-only form `StartTask(task)` when
 * the bound task does not declare a `cluster` in its props. Either declare
 * `cluster` on the Task or pass the cluster explicitly:
 * `StartTask(cluster, task)`.
 */
export class StartTaskRequiresCluster extends Data.TaggedError(
  "StartTaskRequiresCluster",
)<{
  /** Logical id of the task the binding was given. */
  task: string;
  message: string;
}> {}

/**
 * Runtime binding for `ecs:StartTask`.
 *
 * Bind this operation to a `Task` inside a function runtime to get a
 * callable that places the bound task definition on specific container
 * instances (EC2/EXTERNAL launch types — unlike `RunTask`, which lets ECS
 * pick placement). The cluster and task definition ARNs are injected
 * automatically; the host is granted `ecs:StartTask` on the task definition
 * plus `iam:PassRole` on the task and execution roles.
 *
 * The cluster is resolved from the task's declared `cluster` prop; binding
 * a task that declares no cluster fails at bind time (plan time) with
 * {@link StartTaskRequiresCluster}. Pass a `Cluster` explicitly —
 * `StartTask(cluster, task)` — to place the task definition on a different
 * cluster than the one it declares (or when the task declares none).
 * @binding
 * @section Running Tasks
 * @example Start a Task on a Specific Container Instance
 * ```typescript
 * // `task` declares its home cluster: Task("Job", { cluster, ... })
 * const startTask = yield* AWS.ECS.StartTask(task).pipe(Effect.orDie);
 *
 * const response = yield* startTask({
 *   containerInstances: [containerInstanceArn],
 *   startedBy: "placement-controller",
 * });
 * const taskArn = response.tasks?.[0]?.taskArn;
 * ```
 *
 * @example Start on an Explicit Cluster
 * ```typescript
 * // Overrides (or supplies) the cluster — the task definition itself is
 * // not cluster-scoped.
 * const startTask = yield* AWS.ECS.StartTask(cluster, task);
 * ```
 */
export interface StartTask extends Binding.Service<
  StartTask,
  "AWS.ECS.StartTask",
  (
    ...args: [cluster: Cluster, task: Task] | [task: Task]
  ) => Effect.Effect<
    (
      request: StartTaskRequest,
    ) => Effect.Effect<ECS.StartTaskResponse, ECS.StartTaskError>,
    StartTaskRequiresCluster
  >
> {
  /**
   * Explicit-cluster form — places the bound task definition on `cluster`.
   * Cannot fail at bind time.
   */
  <Req = never>(
    cluster: Input<Cluster> | Effect.Effect<Cluster, never, Req>,
    task: Input<Task> | Effect.Effect<Task, never, Req>,
  ): Effect.Effect<
    (
      request: StartTaskRequest,
    ) => Effect.Effect<ECS.StartTaskResponse, ECS.StartTaskError>,
    never,
    StartTask | Req
  >;
  /**
   * Task-only form — places on the cluster the task declares via its
   * `cluster` prop; fails at bind time with {@link StartTaskRequiresCluster}
   * when the task declares none.
   */
  <Req = never>(
    task: Input<Task> | Effect.Effect<Task, never, Req>,
  ): Effect.Effect<
    (
      request: StartTaskRequest,
    ) => Effect.Effect<ECS.StartTaskResponse, ECS.StartTaskError>,
    StartTaskRequiresCluster,
    StartTask | Req
  >;
}
export const StartTask = Binding.Service<StartTask>("AWS.ECS.StartTask");
