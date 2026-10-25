import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetRouterQueueStatistics } from "./GetRouterQueueStatistics.ts";

/**
 * Implementation of {@link GetRouterQueueStatistics} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetRouterQueueStatistics
 */
export const GetRouterQueueStatisticsHttp = Layer.effect(
  GetRouterQueueStatistics,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetRouterQueueStatistics",
    operation: jobRouter.GetJobRouterOperationQueueStatistics,
    grant: CommunicationRole.Data,
  }),
);
