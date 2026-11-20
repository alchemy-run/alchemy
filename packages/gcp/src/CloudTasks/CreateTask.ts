import * as cloudtasks from "@distilled.cloud/gcp/cloudtasks_v2";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Queue } from "./Queue.ts";

export interface CreateTaskRequest extends Omit<
  cloudtasks.CreateProjectsLocationsQueuesTasksRequest,
  "parent"
> {}

/**
 * Runtime binding for Cloud Tasks `queues.tasks.create`.
 *
 * Bind this operation to a {@link Queue} in a Function/Action init phase.
 * Provide {@link CreateTaskHttp}.
 *
 * ### Creating Tasks
 * **Example:** Enqueue an HTTP task
 * ```typescript
 * const createTask = yield* GCP.CloudTasks.CreateTask(queue);
 * yield* createTask({
 *   body: {
 *     task: {
 *       httpRequest: {
 *         url: "https://example.com/jobs",
 *         httpMethod: "POST",
 *         body: btoa(JSON.stringify({ id: "1" })),
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @binding
 * @category CloudTasks
 */
export interface CreateTask extends Binding.Service<
  CreateTask,
  "GCP.CloudTasks.CreateTask",
  (
    queue: Queue,
  ) => Effect.Effect<
    (
      request: CreateTaskRequest,
    ) => Effect.Effect<
      cloudtasks.Task,
      cloudtasks.CreateProjectsLocationsQueuesTasksError,
      RuntimeContext
    >
  >
> {}

export const CreateTask = Binding.Service<CreateTask>("GCP.CloudTasks.CreateTask");

/**
 * HTTP implementation of {@link CreateTask}.
 *
 * @layer
 * @provides GCP.CloudTasks.CreateTask
 */
export const CreateTaskHttp = Layer.effect(
  CreateTask,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const createTask = yield* GCPBindings.withCredentials(
      cloudtasks.createProjectsLocationsQueuesTasks,
    );
    return Effect.fn(function* (queue: Queue) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.CloudTasks.CreateTask(${queue})`({
          iam: [
            grantFor({ role: "roles/cloudtasks.enqueuer", on: "cloudtasks.queue" }, queue.name),
          ],
        });
      }
      const name = yield* queue.name;
      return Effect.fn(`GCP.CloudTasks.CreateTask(${queue.LogicalId})`)(function* (
        request: CreateTaskRequest,
      ) {
        return yield* createTask({
          ...request,
          parent: yield* name,
        });
      });
    });
  }),
);
