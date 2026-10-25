import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ReclassifyRouterJob } from "./ReclassifyRouterJob.ts";

/**
 * Implementation of {@link ReclassifyRouterJob} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ReclassifyRouterJob
 */
export const ReclassifyRouterJobHttp = Layer.effect(
  ReclassifyRouterJob,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ReclassifyRouterJob",
    operation: jobRouter.JobRouterOperationsReclassifyJob,
    grant: CommunicationRole.Data,
  }),
);
