import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { StartInvestigationDiscoveryEngine } from "./StartInvestigationDiscoveryEngine.ts";

/**
 * Implementation of {@link StartInvestigationDiscoveryEngine} over the
 * distilled `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryInvestigationWriteRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.StartInvestigationDiscoveryEngine
 */
export const StartInvestigationDiscoveryEngineHttp = Layer.effect(
  StartInvestigationDiscoveryEngine,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.StartInvestigationDiscoveryEngine",
    operation: discovery.StartInvestigationDiscoveryEngine,
    grant: DiscoveryRole.InvestigationWrite,
  }),
);
