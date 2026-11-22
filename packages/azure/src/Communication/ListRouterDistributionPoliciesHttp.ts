import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListRouterDistributionPolicies } from "./ListRouterDistributionPolicies.ts";

/**
 * Implementation of {@link ListRouterDistributionPolicies} over the
 * distilled `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ListRouterDistributionPolicies
 */
export const ListRouterDistributionPoliciesHttp = Layer.effect(
  ListRouterDistributionPolicies,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListRouterDistributionPolicies",
    operation: jobRouter.ListJobRouterAdministrationOperationDistributionPolicies,
    grant: CommunicationRole.Data,
  }),
);
