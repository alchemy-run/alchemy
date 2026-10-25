import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { Pipeline } from "./Pipeline.ts";
import { RunPipeline } from "./RunPipeline.ts";

/**
 * Implementation of {@link RunPipeline} over the distilled `datafactory` ARM
 * operation `CreatePipelineRun`. Assigns the custom `AzureDataFactoryRunPipelineRole` on
 * the pipeline.
 *
 * @layer
 * @provides Azure.DataFactory.RunPipeline
 */
export const RunPipelineHttp = Layer.effect(
  RunPipeline,
  makeArmActionBinding({
    tag: "Azure.DataFactory.RunPipeline",
    operation: datafactory.CreatePipelineRun,
    role: {
      role: "DataFactoryRunPipeline",
      actions: ["Microsoft.DataFactory/factories/pipelines/createrun/action"],
    },
    resourceId: (pipeline: Pipeline) => pipeline.pipelineId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      factoryName: id.name("factories"),
      pipelineName: id.name("pipelines"),
    }),
  }),
);
