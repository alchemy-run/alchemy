import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { UpdateInvestigation } from "./UpdateInvestigation.ts";

/**
 * Implementation of {@link UpdateInvestigation} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryInvestigationWriteRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.UpdateInvestigation
 */
export const UpdateInvestigationHttp = Layer.effect(
  UpdateInvestigation,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.UpdateInvestigation",
    operation: discovery.UpdateInvestigation,
    grant: DiscoveryRole.InvestigationWrite,
  }),
);
