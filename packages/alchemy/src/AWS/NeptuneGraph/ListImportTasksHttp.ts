import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import { makeNeptuneGraphAccountHttpBinding } from "./BindingHttp.ts";
import { ListImportTasks } from "./ListImportTasks.ts";

export const ListImportTasksHttp = Layer.effect(
  ListImportTasks,
  makeNeptuneGraphAccountHttpBinding({
    tag: "AWS.NeptuneGraph.ListImportTasks",
    operation: neptunegraph.listImportTasks,
    actions: ["neptune-graph:ListImportTasks"],
  }),
);
