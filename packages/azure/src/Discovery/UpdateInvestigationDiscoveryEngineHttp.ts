import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { UpdateInvestigationDiscoveryEngine } from "./UpdateInvestigationDiscoveryEngine.ts";

/**
 * Implementation of {@link UpdateInvestigationDiscoveryEngine} over the
 * distilled `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryInvestigationWriteRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.UpdateInvestigationDiscoveryEngine
 */
export const UpdateInvestigationDiscoveryEngineHttp = Layer.effect(
  UpdateInvestigationDiscoveryEngine,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.UpdateInvestigationDiscoveryEngine",
    operation: discovery.UpdateInvestigationDiscoveryEngine,
    grant: DiscoveryRole.InvestigationWrite,
  }),
);
