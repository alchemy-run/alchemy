import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { GetToolOperations } from "./GetToolOperations.ts";

/**
 * Implementation of {@link GetToolOperations} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryToolOperationReadRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.GetToolOperations
 */
export const GetToolOperationsHttp = Layer.effect(
  GetToolOperations,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.GetToolOperations",
    operation: discovery.GetToolOperations,
    grant: DiscoveryRole.ToolOperationRead,
  }),
);
