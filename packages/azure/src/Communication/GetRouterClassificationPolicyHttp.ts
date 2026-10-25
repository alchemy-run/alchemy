import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetRouterClassificationPolicy } from "./GetRouterClassificationPolicy.ts";

/**
 * Implementation of {@link GetRouterClassificationPolicy} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetRouterClassificationPolicy
 */
export const GetRouterClassificationPolicyHttp = Layer.effect(
  GetRouterClassificationPolicy,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetRouterClassificationPolicy",
    operation: jobRouter.GetJobRouterAdministrationOperationClassificationPolicy,
    grant: CommunicationRole.Data,
  }),
);
