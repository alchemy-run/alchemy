import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { GetToolRunStatus } from "./GetToolRunStatus.ts";

/**
 * Implementation of {@link GetToolRunStatus} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryToolOperationReadRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.GetToolRunStatus
 */
export const GetToolRunStatusHttp = Layer.effect(
  GetToolRunStatus,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.GetToolRunStatus",
    operation: discovery.GetToolRunStatus,
    grant: DiscoveryRole.ToolOperationRead,
  }),
);
