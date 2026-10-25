import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { DeleteRouterDistributionPolicy } from "./DeleteRouterDistributionPolicy.ts";

/**
 * Implementation of {@link DeleteRouterDistributionPolicy} over the
 * distilled `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.DeleteRouterDistributionPolicy
 */
export const DeleteRouterDistributionPolicyHttp = Layer.effect(
  DeleteRouterDistributionPolicy,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.DeleteRouterDistributionPolicy",
    operation: jobRouter.DeleteJobRouterAdministrationOperationDistributionPolicy,
    grant: CommunicationRole.Data,
  }),
);
