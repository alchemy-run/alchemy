import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { DeleteRouterExceptionPolicy } from "./DeleteRouterExceptionPolicy.ts";

/**
 * Implementation of {@link DeleteRouterExceptionPolicy} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.DeleteRouterExceptionPolicy
 */
export const DeleteRouterExceptionPolicyHttp = Layer.effect(
  DeleteRouterExceptionPolicy,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.DeleteRouterExceptionPolicy",
    operation: jobRouter.DeleteJobRouterAdministrationOperationExceptionPolicy,
    grant: CommunicationRole.Data,
  }),
);
