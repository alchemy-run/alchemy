import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListRouterWorkers } from "./ListRouterWorkers.ts";

/**
 * Implementation of {@link ListRouterWorkers} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ListRouterWorkers
 */
export const ListRouterWorkersHttp = Layer.effect(
  ListRouterWorkers,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListRouterWorkers",
    operation: jobRouter.ListJobRouterOperationWorkers,
    grant: CommunicationRole.Data,
  }),
);
