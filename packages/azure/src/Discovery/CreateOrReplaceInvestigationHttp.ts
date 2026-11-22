import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { CreateOrReplaceInvestigation } from "./CreateOrReplaceInvestigation.ts";

/**
 * Implementation of {@link CreateOrReplaceInvestigation} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryInvestigationWriteRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.CreateOrReplaceInvestigation
 */
export const CreateOrReplaceInvestigationHttp = Layer.effect(
  CreateOrReplaceInvestigation,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.CreateOrReplaceInvestigation",
    operation: discovery.InvestigationsCreateOrReplace,
    grant: DiscoveryRole.InvestigationWrite,
  }),
);
