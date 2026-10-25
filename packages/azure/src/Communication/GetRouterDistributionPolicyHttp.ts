import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetRouterDistributionPolicy } from "./GetRouterDistributionPolicy.ts";

/**
 * Implementation of {@link GetRouterDistributionPolicy} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetRouterDistributionPolicy
 */
export const GetRouterDistributionPolicyHttp = Layer.effect(
  GetRouterDistributionPolicy,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetRouterDistributionPolicy",
    operation: jobRouter.GetJobRouterAdministrationOperationDistributionPolicy,
    grant: CommunicationRole.Data,
  }),
);
