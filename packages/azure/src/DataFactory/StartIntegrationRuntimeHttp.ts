import * as datafactory from "@distilled.cloud/azure/datafactory";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { IntegrationRuntime } from "./IntegrationRuntime.ts";
import { StartIntegrationRuntime } from "./StartIntegrationRuntime.ts";

/**
 * Implementation of {@link StartIntegrationRuntime} over the distilled `datafactory` ARM
 * operation `StartIntegrationRuntime`. Assigns the custom `AzureDataFactoryStartIntegrationRuntimeRole` on
 * the integration runtime.
 *
 * @layer
 * @provides Azure.DataFactory.StartIntegrationRuntime
 */
export const StartIntegrationRuntimeHttp = Layer.effect(
  StartIntegrationRuntime,
  makeArmActionBinding({
    tag: "Azure.DataFactory.StartIntegrationRuntime",
    operation: datafactory.StartIntegrationRuntime,
    role: {
      role: "DataFactoryStartIntegrationRuntime",
      actions: ["Microsoft.DataFactory/factories/integrationruntimes/start/action"],
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
