import * as neptunegraph from "@distilled.cloud/aws/neptune-graph";
import * as Layer from "effect/Layer";
import { makeNeptuneGraphAccountHttpBinding } from "./BindingHttp.ts";
import { GetImportTask } from "./GetImportTask.ts";

export const GetImportTaskHttp = Layer.effect(
  GetImportTask,
  makeNeptuneGraphAccountHttpBinding({
    tag: "AWS.NeptuneGraph.GetImportTask",
    operation: neptunegraph.getImportTask,
    actions: ["neptune-graph:GetImportTask"],
  }),
);
