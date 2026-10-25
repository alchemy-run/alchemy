import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { GetInvestigationDiscoveryEngine } from "./GetInvestigationDiscoveryEngine.ts";

/**
 * Implementation of {@link GetInvestigationDiscoveryEngine} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryInvestigationReadRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.GetInvestigationDiscoveryEngine
 */
export const GetInvestigationDiscoveryEngineHttp = Layer.effect(
  GetInvestigationDiscoveryEngine,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.GetInvestigationDiscoveryEngine",
    operation: discovery.GetInvestigationDiscoveryEngine,
    grant: DiscoveryRole.InvestigationRead,
  }),
);
