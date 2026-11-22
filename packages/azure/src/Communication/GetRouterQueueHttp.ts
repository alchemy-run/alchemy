import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetRouterQueue } from "./GetRouterQueue.ts";

/**
 * Implementation of {@link GetRouterQueue} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetRouterQueue
 */
export const GetRouterQueueHttp = Layer.effect(
  GetRouterQueue,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetRouterQueue",
    operation: jobRouter.GetJobRouterAdministrationOperationQueue,
    grant: CommunicationRole.Data,
  }),
);
