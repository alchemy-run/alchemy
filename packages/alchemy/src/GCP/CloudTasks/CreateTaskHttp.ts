import * as cloudtasks from "@distilled.cloud/gcp/cloudtasks_v2";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { CreateTask, type CreateTaskRequest } from "./CreateTask.ts";
import type { Queue } from "./Queue.ts";

const createTask = (
  input: cloudtasks.CreateProjectsLocationsQueuesTasksRequest,
): Effect.Effect<
  cloudtasks.Task,
  cloudtasks.CreateProjectsLocationsQueuesTasksError,
  Credentials | HttpClient.HttpClient
> => cloudtasks.createProjectsLocationsQueuesTasks(input);

/**
 * HTTP implementation of {@link CreateTask}.
 *
 * @layer
 * @provides GCP.CloudTasks.CreateTask
 */
export const CreateTaskHttp = Layer.effect(
  CreateTask,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* (queue: Queue) {
      const name = yield* queue.name;
      return Effect.fn(`GCP.CloudTasks.CreateTask(${queue.LogicalId})`)(
        function* (request: CreateTaskRequest) {
          return yield* createTask({
            ...request,
            parent: yield* name,
          }).pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
        },
      );
    });
  }),
);
