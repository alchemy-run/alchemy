import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { ListInvestigations } from "./ListInvestigations.ts";

/**
 * Implementation of {@link ListInvestigations} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryInvestigationReadRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.ListInvestigations
 */
export const ListInvestigationsHttp = Layer.effect(
  ListInvestigations,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.ListInvestigations",
    operation: discovery.ListInvestigations,
    grant: DiscoveryRole.InvestigationRead,
  }),
);
