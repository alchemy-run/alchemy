import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UpsertRouterExceptionPolicy } from "./UpsertRouterExceptionPolicy.ts";

/**
 * Implementation of {@link UpsertRouterExceptionPolicy} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.UpsertRouterExceptionPolicy
 */
export const UpsertRouterExceptionPolicyHttp = Layer.effect(
  UpsertRouterExceptionPolicy,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UpsertRouterExceptionPolicy",
    operation: jobRouter.UpsertJobRouterAdministrationOperationExceptionPolicy,
    grant: CommunicationRole.Data,
  }),
);
