import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import { CancelPipelineRun } from "./CancelPipelineRun.ts";
import type { Factory } from "./Factory.ts";

/**
 * Implementation of {@link CancelPipelineRun} over the distilled `datafactory` ARM
 * operation `CancelPipelineRun`. Assigns the custom `AzureDataFactoryCancelPipelineRunRole` on
 * the factory.
 *
 * @layer
 * @provides Azure.DataFactory.CancelPipelineRun
 */
export const CancelPipelineRunHttp = Layer.effect(
  CancelPipelineRun,
  makeArmActionBinding({
    tag: "Azure.DataFactory.CancelPipelineRun",
    operation: datafactory.CancelPipelineRun,
    role: {
      role: "DataFactoryCancelPipelineRun",
      actions: ["Microsoft.DataFactory/factories/pipelineruns/cancel/action"],
    },
    resourceId: (factory: Factory) => factory.factoryId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      factoryName: id.name("factories"),
    }),
  }),
);
