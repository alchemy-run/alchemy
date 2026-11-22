import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { CancelRouterJob } from "./CancelRouterJob.ts";

/**
 * Implementation of {@link CancelRouterJob} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.CancelRouterJob
 */
export const CancelRouterJobHttp = Layer.effect(
  CancelRouterJob,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.CancelRouterJob",
    operation: jobRouter.CancelJobRouterOperationJob,
    grant: CommunicationRole.Data,
  }),
);
