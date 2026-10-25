import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UpsertRouterJob } from "./UpsertRouterJob.ts";

/**
 * Implementation of {@link UpsertRouterJob} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.UpsertRouterJob
 */
export const UpsertRouterJobHttp = Layer.effect(
  UpsertRouterJob,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UpsertRouterJob",
    operation: jobRouter.UpsertJobRouterOperationJob,
    grant: CommunicationRole.Data,
  }),
);
