import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import { makeNeptuneGraphAccountHttpBinding } from "./BindingHttp.ts";
import { CancelExportTask } from "./CancelExportTask.ts";

export const CancelExportTaskHttp = Layer.effect(
  CancelExportTask,
  makeNeptuneGraphAccountHttpBinding({
    tag: "AWS.NeptuneGraph.CancelExportTask",
    operation: neptunegraph.cancelExportTask,
    actions: ["neptune-graph:CancelExportTask"],
  }),
);
