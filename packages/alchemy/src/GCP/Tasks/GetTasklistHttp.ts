import * as tasks from "@distilled.cloud/gcp/tasks_v1";
import * as Layer from "effect/Layer";
import { makeTasklistHttpBinding } from "./BindingHttp.ts";
import { GetTasklist } from "./GetTasklist.ts";

/**
 * HTTP implementation of {@link GetTasklist}.
 *
 * @layer
 * @provides GCP.Tasks.GetTasklist
 */
export const GetTasklistHttp = Layer.effect(
  GetTasklist,
  makeTasklistHttpBinding({
    tag: "GCP.Tasks.GetTasklist",
    operation: tasks.getTasklists,
  }),
);
