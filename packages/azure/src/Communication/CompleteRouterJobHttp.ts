import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { CompleteRouterJob } from "./CompleteRouterJob.ts";

/**
 * Implementation of {@link CompleteRouterJob} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.CompleteRouterJob
 */
export const CompleteRouterJobHttp = Layer.effect(
  CompleteRouterJob,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.CompleteRouterJob",
    operation: jobRouter.CompleteJobRouterOperationJob,
    grant: CommunicationRole.Data,
  }),
);
