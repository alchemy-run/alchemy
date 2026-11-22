import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListRouterQueues } from "./ListRouterQueues.ts";

/**
 * Implementation of {@link ListRouterQueues} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ListRouterQueues
 */
export const ListRouterQueuesHttp = Layer.effect(
  ListRouterQueues,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListRouterQueues",
    operation: jobRouter.ListJobRouterAdministrationOperationQueues,
    grant: CommunicationRole.Data,
  }),
);
