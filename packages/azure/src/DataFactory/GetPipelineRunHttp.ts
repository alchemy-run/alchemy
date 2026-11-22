import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { Factory } from "./Factory.ts";
import { GetPipelineRun } from "./GetPipelineRun.ts";

/**
 * Implementation of {@link GetPipelineRun} over the distilled `datafactory` ARM
 * operation `GetPipelineRun`. Assigns the custom `AzureDataFactoryGetPipelineRunRole` on
 * the factory.
 *
 * @layer
 * @provides Azure.DataFactory.GetPipelineRun
 */
export const GetPipelineRunHttp = Layer.effect(
  GetPipelineRun,
  makeArmActionBinding({
    tag: "Azure.DataFactory.GetPipelineRun",
    operation: datafactory.GetPipelineRun,
    role: {
      role: "DataFactoryGetPipelineRun",
      actions: ["Microsoft.DataFactory/factories/pipelineruns/read"],
    },
    resourceId: (factory: Factory) => factory.factoryId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      factoryName: id.name("factories"),
    }),
  }),
);
