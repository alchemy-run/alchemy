import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { StopInvestigationDiscoveryEngine } from "./StopInvestigationDiscoveryEngine.ts";

/**
 * Implementation of {@link StopInvestigationDiscoveryEngine} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryInvestigationWriteRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.StopInvestigationDiscoveryEngine
 */
export const StopInvestigationDiscoveryEngineHttp = Layer.effect(
  StopInvestigationDiscoveryEngine,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.StopInvestigationDiscoveryEngine",
    operation: discovery.StopInvestigationDiscoveryEngine,
    grant: DiscoveryRole.InvestigationWrite,
  }),
);
