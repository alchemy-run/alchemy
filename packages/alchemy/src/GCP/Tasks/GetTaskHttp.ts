import * as tasks from "@distilled.cloud/gcp/tasks_v1";
import * as Layer from "effect/Layer";
import { makeTaskHttpBinding } from "./BindingHttp.ts";
import { GetTask } from "./GetTask.ts";

/**
 * HTTP implementation of {@link GetTask}.
 *
 * @layer
 * @provides GCP.Tasks.GetTask
 */
export const GetTaskHttp = Layer.effect(
  GetTask,
  makeTaskHttpBinding({
    tag: "GCP.Tasks.GetTask",
    operation: tasks.getTasks,
  }),
);
