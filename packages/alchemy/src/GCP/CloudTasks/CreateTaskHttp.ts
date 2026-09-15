import * as cloudtasks from "@distilled.cloud/gcp/cloudtasks_v2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CreateTask, type CreateTaskRequest } from "./CreateTask.ts";
import type { Queue } from "./Queue.ts";
import { bindGcpHost, defaultRoleFor } from "../Host.ts";

/**
 * HTTP implementation of {@link CreateTask}.
 *
 * @layer
 * @provides GCP.CloudTasks.CreateTask
 */
export const CreateTaskHttp = Layer.effect(
  CreateTask,
  Effect.gen(function* () {
    const createTask = yield* cloudtasks.createProjectsLocationsQueuesTasks;
    return Effect.fn(function* (queue: Queue) {
      yield* bindGcpHost({
        tag: "GCP.CloudTasks.CreateTask",
        resource: queue,
        iam: [{ role: defaultRoleFor("GCP.CloudTasks.CreateTask") }],
      });
      const name = yield* queue.name;
      return Effect.fn(`GCP.CloudTasks.CreateTask(${queue.LogicalId})`)(
        function* (request: CreateTaskRequest) {
          return yield* createTask({
            ...request,
            parent: yield* name,
          });
        },
      );
    });
  }),
);
