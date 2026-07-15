import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import { makeNeptuneGraphAccountHttpBinding } from "./BindingHttp.ts";
import { GetExportTask } from "./GetExportTask.ts";

export const GetExportTaskHttp = Layer.effect(
  GetExportTask,
  makeNeptuneGraphAccountHttpBinding({
    tag: "AWS.NeptuneGraph.GetExportTask",
    operation: neptunegraph.getExportTask,
    actions: ["neptune-graph:GetExportTask"],
  }),
);
