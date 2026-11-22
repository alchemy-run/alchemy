import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UpsertRouterClassificationPolicy } from "./UpsertRouterClassificationPolicy.ts";

/**
 * Implementation of {@link UpsertRouterClassificationPolicy} over the
 * distilled `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.UpsertRouterClassificationPolicy
 */
export const UpsertRouterClassificationPolicyHttp = Layer.effect(
  UpsertRouterClassificationPolicy,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UpsertRouterClassificationPolicy",
    operation: jobRouter.UpsertJobRouterAdministrationOperationClassificationPolicy,
    grant: CommunicationRole.Data,
  }),
);
