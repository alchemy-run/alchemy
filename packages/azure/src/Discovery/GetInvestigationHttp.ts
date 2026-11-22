import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { GetInvestigation } from "./GetInvestigation.ts";

/**
 * Implementation of {@link GetInvestigation} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryInvestigationReadRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.GetInvestigation
 */
export const GetInvestigationHttp = Layer.effect(
  GetInvestigation,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.GetInvestigation",
    operation: discovery.GetInvestigation,
    grant: DiscoveryRole.InvestigationRead,
  }),
);
