import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { CloseRouterJob } from "./CloseRouterJob.ts";

/**
 * Implementation of {@link CloseRouterJob} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.CloseRouterJob
 */
export const CloseRouterJobHttp = Layer.effect(
  CloseRouterJob,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.CloseRouterJob",
    operation: jobRouter.JobRouterOperationsCloseJob,
    grant: CommunicationRole.Data,
  }),
);
