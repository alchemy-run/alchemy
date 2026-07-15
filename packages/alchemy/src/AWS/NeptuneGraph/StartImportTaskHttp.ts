import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import { makeNeptuneGraphGraphHttpBinding } from "./BindingHttp.ts";
import { StartImportTask } from "./StartImportTask.ts";

export const StartImportTaskHttp = Layer.effect(
  StartImportTask,
  makeNeptuneGraphGraphHttpBinding({
    tag: "AWS.NeptuneGraph.StartImportTask",
    operation: neptunegraph.startImportTask,
    actions: ["neptune-graph:StartImportTask"],
    passRole: true,
  }),
);
