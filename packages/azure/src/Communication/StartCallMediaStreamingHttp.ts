import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { StartCallMediaStreaming } from "./StartCallMediaStreaming.ts";

/**
 * Implementation of {@link StartCallMediaStreaming} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.StartCallMediaStreaming
 */
export const StartCallMediaStreamingHttp = Layer.effect(
  StartCallMediaStreaming,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.StartCallMediaStreaming",
    operation: callAutomation.StartCallMediaMediaStreaming,
    grant: CommunicationRole.Data,
  }),
);
