import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { RunTool } from "./RunTool.ts";

/**
 * Implementation of {@link RunTool} over the distilled `discovery-workspace`
 * data plane. Assigns the custom `AzureDiscoveryToolRunRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.RunTool
 */
export const RunToolHttp = Layer.effect(
  RunTool,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.RunTool",
    operation: discovery.RunTool,
    grant: DiscoveryRole.ToolRun,
  }),
);
