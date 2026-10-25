import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { IntegrationRuntime } from "./IntegrationRuntime.ts";
import { StopIntegrationRuntime } from "./StopIntegrationRuntime.ts";

/**
 * Implementation of {@link StopIntegrationRuntime} over the distilled `datafactory` ARM
 * operation `StopIntegrationRuntime`. Assigns the custom `AzureDataFactoryStopIntegrationRuntimeRole` on
 * the integration runtime.
 *
 * @layer
 * @provides Azure.DataFactory.StopIntegrationRuntime
 */
export const StopIntegrationRuntimeHttp = Layer.effect(
  StopIntegrationRuntime,
  makeArmActionBinding({
    tag: "Azure.DataFactory.StopIntegrationRuntime",
    operation: datafactory.StopIntegrationRuntime,
    role: {
      role: "DataFactoryStopIntegrationRuntime",
      actions: ["Microsoft.DataFactory/factories/integrationruntimes/stop/action"],
    },
    resourceId: (runtime: IntegrationRuntime) => runtime.integrationRuntimeId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      factoryName: id.name("factories"),
      integrationRuntimeName: id.name("integrationRuntimes"),
    }),
  }),
);
