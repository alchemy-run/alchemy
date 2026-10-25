import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { DeleteRouterJob } from "./DeleteRouterJob.ts";

/**
 * Implementation of {@link DeleteRouterJob} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.DeleteRouterJob
 */
export const DeleteRouterJobHttp = Layer.effect(
  DeleteRouterJob,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.DeleteRouterJob",
    operation: jobRouter.DeleteJobRouterOperationJob,
    grant: CommunicationRole.Data,
  }),
);
