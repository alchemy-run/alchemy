import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetRouterJob } from "./GetRouterJob.ts";

/**
 * Implementation of {@link GetRouterJob} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetRouterJob
 */
export const GetRouterJobHttp = Layer.effect(
  GetRouterJob,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetRouterJob",
    operation: jobRouter.GetJobRouterOperationJob,
    grant: CommunicationRole.Data,
  }),
);
