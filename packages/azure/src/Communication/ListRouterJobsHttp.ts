import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListRouterJobs } from "./ListRouterJobs.ts";

/**
 * Implementation of {@link ListRouterJobs} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ListRouterJobs
 */
export const ListRouterJobsHttp = Layer.effect(
  ListRouterJobs,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListRouterJobs",
    operation: jobRouter.ListJobRouterOperationJobs,
    grant: CommunicationRole.Data,
  }),
);
