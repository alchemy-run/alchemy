import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetRouterExceptionPolicy } from "./GetRouterExceptionPolicy.ts";

/**
 * Implementation of {@link GetRouterExceptionPolicy} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetRouterExceptionPolicy
 */
export const GetRouterExceptionPolicyHttp = Layer.effect(
  GetRouterExceptionPolicy,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetRouterExceptionPolicy",
    operation: jobRouter.GetJobRouterAdministrationOperationExceptionPolicy,
    grant: CommunicationRole.Data,
  }),
);
