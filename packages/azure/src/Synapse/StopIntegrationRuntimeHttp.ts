import * as synapse from "@distilled.cloud/azure/synapse";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { IntegrationRuntime } from "./IntegrationRuntime.ts";
import { StopIntegrationRuntime } from "./StopIntegrationRuntime.ts";

/**
 * Implementation of {@link StopIntegrationRuntime} over the distilled `synapse` ARM
 * operation `StopIntegrationRuntime`. Assigns the custom `AzureSynapseStopIntegrationRuntimeRole` on
 * the integration runtime.
 *
 * @layer
 * @provides Azure.Synapse.StopIntegrationRuntime
 */
export const StopIntegrationRuntimeHttp = Layer.effect(
  StopIntegrationRuntime,
  makeArmActionBinding({
    tag: "Azure.Synapse.StopIntegrationRuntime",
    operation: synapse.StopIntegrationRuntime,
    role: {
      role: "SynapseStopIntegrationRuntime",
      actions: ["Microsoft.Synapse/workspaces/integrationRuntimes/stop/action"],
    },
    resourceId: (runtime: IntegrationRuntime) => runtime.integrationRuntimeId,
    identifiers: (id) => ({
      subscriptionId: id.subscriptionId,
      resourceGroupName: id.resourceGroupName,
      workspaceName: id.name("workspaces"),
      integrationRuntimeName: id.name("integrationRuntimes"),
    }),
  }),
);
