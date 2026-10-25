import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListRouterClassificationPolicies } from "./ListRouterClassificationPolicies.ts";

/**
 * Implementation of {@link ListRouterClassificationPolicies} over the
 * distilled `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ListRouterClassificationPolicies
 */
export const ListRouterClassificationPoliciesHttp = Layer.effect(
  ListRouterClassificationPolicies,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListRouterClassificationPolicies",
    operation: jobRouter.ListJobRouterAdministrationOperationClassificationPolicies,
    grant: CommunicationRole.Data,
  }),
);
