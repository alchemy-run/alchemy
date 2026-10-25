import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UpsertRouterDistributionPolicy } from "./UpsertRouterDistributionPolicy.ts";

/**
 * Implementation of {@link UpsertRouterDistributionPolicy} over the
 * distilled `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.UpsertRouterDistributionPolicy
 */
export const UpsertRouterDistributionPolicyHttp = Layer.effect(
  UpsertRouterDistributionPolicy,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UpsertRouterDistributionPolicy",
    operation: jobRouter.UpsertJobRouterAdministrationOperationDistributionPolicy,
    grant: CommunicationRole.Data,
  }),
);
