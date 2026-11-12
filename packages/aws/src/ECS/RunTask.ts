import type * as ECS from "@distilled.cloud/aws/ecs";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Cluster } from "./Cluster.ts";
import type { Task } from "./Task.ts";

export interface RunTaskRequest extends Omit<ECS.RunTaskRequest, "cluster" | "taskDefinition"> {}

/**
 * Runtime binding for `ecs:RunTask`.
 *
 * Bind this operation to a `Cluster` and `Task` inside a function runtime to
 * get a callable that starts a task from the bound task definition, on
 * Fargate or on a capacity provider. The cluster and task definition are
 * injected automatically; the host is granted `ecs:RunTask` on the task
 * definition plus `iam:PassRole` on the task and execution roles. The rest of
 * the request is ECS's own `RunTask` request.
 *
 * ### Running Tasks
 * **Example:** Launch a Fargate Task from a handler
 * ```typescript
 * const api = yield* AWS.Lambda.Function(
 *   "Api",
 *   { main: import.meta.url, functionUrl: true },
 *   Effect.gen(function* () {
 *     // init: bind the launch (IAM grants happen here)
 *     const runTask = yield* AWS.ECS.RunTask(cluster, task);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // runtime: launch a task per request
 *         const response = yield* runTask({
 *           launchType: "FARGATE",
 *           networkConfiguration: {
 *             awsvpcConfiguration: {
 *               subnets: [subnetId],
 *               assignPublicIp: "ENABLED",
 *             },
 *           },
 *         });
 *         return yield* HttpServerResponse.json({
 *           taskArn: response.tasks?.[0]?.taskArn,
 *         });
 *       }),
 *     };
 *   }),
 * );
 * ```
 *
 * **Example:** Run an isolated Task on a capacity provider
 * A Task with `isolation: "isolated"` runs in its own Nitro Sandbox on a
 * Managed Instances capacity provider. Name the provider and the subnets; the
 * task joins the VPC's default security group unless you pass
 * `securityGroups`.
 * ```typescript
 * const capacity = yield* Capacity;
 * const runTask = yield* AWS.ECS.RunTask(Cluster, MyJob);
 * const CapacityName = yield* capacity.name;
 * const Subnets = yield* capacity.subnets;
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const { tasks } = yield* runTask({
 *       capacityProviderStrategy: [{ capacityProvider: yield* CapacityName, weight: 1 }],
 *       networkConfiguration: { awsvpcConfiguration: { subnets: yield* Subnets } },
 *     });
 *     return HttpServerResponse.text(tasks?.[0]?.taskArn ?? "no task started");
 *   }).pipe(Effect.orDie),
 * };
 * ```
 *
 * @binding
 */
export interface RunTask extends Binding.Service<
  RunTask,
  "AWS.ECS.RunTask",
  (
    cluster: Cluster,
    task: Task,
  ) => Effect.Effect<
    (request: RunTaskRequest) => Effect.Effect<ECS.RunTaskResponse, ECS.RunTaskError>
  >
> {}
export const RunTask = Binding.Service<RunTask>("AWS.ECS.RunTask");
