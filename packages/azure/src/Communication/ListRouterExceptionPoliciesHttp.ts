import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListRouterExceptionPolicies } from "./ListRouterExceptionPolicies.ts";

/**
 * Implementation of {@link ListRouterExceptionPolicies} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ListRouterExceptionPolicies
 */
export const ListRouterExceptionPoliciesHttp = Layer.effect(
  ListRouterExceptionPolicies,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListRouterExceptionPolicies",
    operation: jobRouter.ListJobRouterAdministrationOperationExceptionPolicies,
    grant: CommunicationRole.Data,
  }),
);
