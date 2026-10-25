import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UpsertRouterWorker } from "./UpsertRouterWorker.ts";

/**
 * Implementation of {@link UpsertRouterWorker} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.UpsertRouterWorker
 */
export const UpsertRouterWorkerHttp = Layer.effect(
  UpsertRouterWorker,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UpsertRouterWorker",
    operation: jobRouter.UpsertJobRouterOperationWorker,
    grant: CommunicationRole.Data,
  }),
);
