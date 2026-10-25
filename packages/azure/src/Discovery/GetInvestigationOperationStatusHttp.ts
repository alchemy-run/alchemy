import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { GetInvestigationOperationStatus } from "./GetInvestigationOperationStatus.ts";

/**
 * Implementation of {@link GetInvestigationOperationStatus} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryInvestigationReadRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.GetInvestigationOperationStatus
 */
export const GetInvestigationOperationStatusHttp = Layer.effect(
  GetInvestigationOperationStatus,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.GetInvestigationOperationStatus",
    operation: discovery.GetInvestigationOperationStatus,
    grant: DiscoveryRole.InvestigationRead,
  }),
);
