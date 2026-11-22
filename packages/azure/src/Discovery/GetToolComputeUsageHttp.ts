import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { GetToolComputeUsage } from "./GetToolComputeUsage.ts";

/**
 * Implementation of {@link GetToolComputeUsage} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryToolOperationReadRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.GetToolComputeUsage
 */
export const GetToolComputeUsageHttp = Layer.effect(
  GetToolComputeUsage,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.GetToolComputeUsage",
    operation: discovery.GetToolComputeUsage,
    grant: DiscoveryRole.ToolOperationRead,
  }),
);
