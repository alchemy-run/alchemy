import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UnassignRouterJob } from "./UnassignRouterJob.ts";

/**
 * Implementation of {@link UnassignRouterJob} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.UnassignRouterJob
 */
export const UnassignRouterJobHttp = Layer.effect(
  UnassignRouterJob,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UnassignRouterJob",
    operation: jobRouter.UnassignJobRouterOperationJob,
    grant: CommunicationRole.Data,
  }),
);
