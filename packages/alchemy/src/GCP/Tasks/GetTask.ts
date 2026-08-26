import type * as tasks from "@distilled.cloud/gcp/tasks_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Task } from "./Task.ts";

export interface GetTaskRequest extends Omit<
  tasks.GetTasksRequest,
  "tasklist" | "task"
> {}

/**
 * Runtime binding for Tasks `tasks.get`.
 *
 * Bind this operation to a {@link Task} in a Function/Action init
 * phase. Provide {@link GetTaskHttp}.
 *
 * ### Reading Tasks
 * **Example:** Read task metadata
 * ```typescript
 * const getTask = yield* GCP.Tasks.GetTask(item);
 * const metadata = yield* getTask({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Tasks
 */
export interface GetTask extends Binding.Service<
  GetTask,
  "GCP.Tasks.GetTask",
  (
    item: Task,
  ) => Effect.Effect<
    (
      request: GetTaskRequest,
    ) => Effect.Effect<tasks.Task, tasks.GetTasksError, RuntimeContext>
  >
> {}

export const GetTask = Binding.Service<GetTask>("GCP.Tasks.GetTask");
