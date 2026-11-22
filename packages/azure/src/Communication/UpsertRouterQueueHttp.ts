import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UpsertRouterQueue } from "./UpsertRouterQueue.ts";

/**
 * Implementation of {@link UpsertRouterQueue} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.UpsertRouterQueue
 */
export const UpsertRouterQueueHttp = Layer.effect(
  UpsertRouterQueue,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UpsertRouterQueue",
    operation: jobRouter.UpsertJobRouterAdministrationOperationQueue,
    grant: CommunicationRole.Data,
  }),
);
