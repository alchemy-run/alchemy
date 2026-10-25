import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { CancelToolRun } from "./CancelToolRun.ts";

/**
 * Implementation of {@link CancelToolRun} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryToolOperationCancelRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.CancelToolRun
 */
export const CancelToolRunHttp = Layer.effect(
  CancelToolRun,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.CancelToolRun",
    operation: discovery.CancelToolRunLro,
    grant: DiscoveryRole.ToolOperationCancel,
  }),
);
