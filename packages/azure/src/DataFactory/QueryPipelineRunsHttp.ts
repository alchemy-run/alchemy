import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { Factory } from "./Factory.ts";
import { QueryPipelineRuns } from "./QueryPipelineRuns.ts";

/**
 * Implementation of {@link QueryPipelineRuns} over the distilled `datafactory` ARM
 * operation `PipelineRunsQueryByFactory`. Assigns the custom `AzureDataFactoryQueryPipelineRunsRole` on
 * the factory.
 *
 * @layer
 * @provides Azure.DataFactory.QueryPipelineRuns
 */
export const QueryPipelineRunsHttp = Layer.effect(
  QueryPipelineRuns,
  makeArmActionBinding({
    tag: "Azure.DataFactory.QueryPipelineRuns",
    operation: datafactory.PipelineRunsQueryByFactory,
    role: {
      role: "DataFactoryQueryPipelineRuns",
      actions: ["Microsoft.DataFactory/factories/querypipelineruns/read"],
    },
    resourceId: (factory: Factory) => factory.factoryId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      factoryName: id.name("factories"),
    }),
  }),
);
