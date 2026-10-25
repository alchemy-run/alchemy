import * as jobRouter from "@distilled.cloud/azure/communication-job-router";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetRouterWorker } from "./GetRouterWorker.ts";

/**
 * Implementation of {@link GetRouterWorker} over the distilled
 * `communication-job-router` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetRouterWorker
 */
export const GetRouterWorkerHttp = Layer.effect(
  GetRouterWorker,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetRouterWorker",
    operation: jobRouter.GetJobRouterOperationWorker,
    grant: CommunicationRole.Data,
  }),
);
