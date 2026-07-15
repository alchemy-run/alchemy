import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import { makeNeptuneGraphGraphHttpBinding } from "./BindingHttp.ts";
import { StartExportTask } from "./StartExportTask.ts";

export const StartExportTaskHttp = Layer.effect(
  StartExportTask,
  makeNeptuneGraphGraphHttpBinding({
    tag: "AWS.NeptuneGraph.StartExportTask",
    operation: neptunegraph.startExportTask,
    actions: ["neptune-graph:StartExportTask"],
    passRole: true,
  }),
);
