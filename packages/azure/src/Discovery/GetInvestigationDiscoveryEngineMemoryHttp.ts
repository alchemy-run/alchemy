import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { GetInvestigationDiscoveryEngineMemory } from "./GetInvestigationDiscoveryEngineMemory.ts";

/**
 * Implementation of {@link GetInvestigationDiscoveryEngineMemory} over the
 * distilled `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryInvestigationReadRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.GetInvestigationDiscoveryEngineMemory
 */
export const GetInvestigationDiscoveryEngineMemoryHttp = Layer.effect(
  GetInvestigationDiscoveryEngineMemory,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.GetInvestigationDiscoveryEngineMemory",
    operation: discovery.GetInvestigationDiscoveryEngineMemory,
    grant: DiscoveryRole.InvestigationRead,
  }),
);
