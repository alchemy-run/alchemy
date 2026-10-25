import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { DeleteRouterQueue } from "./DeleteRouterQueue.ts";

/**
 * Implementation of {@link DeleteRouterQueue} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.DeleteRouterQueue
 */
export const DeleteRouterQueueHttp = Layer.effect(
  DeleteRouterQueue,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.DeleteRouterQueue",
    operation: jobRouter.DeleteJobRouterAdministrationOperationQueue,
    grant: CommunicationRole.Data,
  }),
);
