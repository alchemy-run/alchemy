import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { DeleteRouterClassificationPolicy } from "./DeleteRouterClassificationPolicy.ts";

/**
 * Implementation of {@link DeleteRouterClassificationPolicy} over the
 * distilled `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.DeleteRouterClassificationPolicy
 */
export const DeleteRouterClassificationPolicyHttp = Layer.effect(
  DeleteRouterClassificationPolicy,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.DeleteRouterClassificationPolicy",
    operation: jobRouter.DeleteJobRouterAdministrationOperationClassificationPolicy,
    grant: CommunicationRole.Data,
  }),
);
