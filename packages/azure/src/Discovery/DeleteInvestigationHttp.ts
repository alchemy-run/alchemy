import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { DeleteInvestigation } from "./DeleteInvestigation.ts";

/**
 * Implementation of {@link DeleteInvestigation} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryInvestigationDeleteRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.DeleteInvestigation
 */
export const DeleteInvestigationHttp = Layer.effect(
  DeleteInvestigation,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.DeleteInvestigation",
    operation: discovery.DeleteInvestigation,
    grant: DiscoveryRole.InvestigationDelete,
  }),
);
