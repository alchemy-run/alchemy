import * as synapse from "@distilled.cloud/azure/synapse";
import * as Layer from "effect/Layer";
import { makeArmActionBinding } from "../internal/ArmActionBinding.ts";
import type { IntegrationRuntime } from "./IntegrationRuntime.ts";
import { StartIntegrationRuntime } from "./StartIntegrationRuntime.ts";

/**
 * Implementation of {@link StartIntegrationRuntime} over the distilled `synapse` ARM
 * operation `StartIntegrationRuntime`. Assigns the custom `AzureSynapseStartIntegrationRuntimeRole` on
 * the integration runtime.
 *
 * @layer
 * @provides Azure.Synapse.StartIntegrationRuntime
 */
export const StartIntegrationRuntimeHttp = Layer.effect(
  StartIntegrationRuntime,
  makeArmActionBinding({
    tag: "Azure.Synapse.StartIntegrationRuntime",
    operation: synapse.StartIntegrationRuntime,
    role: {
      role: "SynapseStartIntegrationRuntime",
      actions: ["Microsoft.Synapse/workspaces/integrationRuntimes/start/action"],
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
