import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { StopCallMediaStreaming } from "./StopCallMediaStreaming.ts";

/**
 * Implementation of {@link StopCallMediaStreaming} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.StopCallMediaStreaming
 */
export const StopCallMediaStreamingHttp = Layer.effect(
  StopCallMediaStreaming,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.StopCallMediaStreaming",
    operation: callAutomation.StopCallMediaMediaStreaming,
    grant: CommunicationRole.Data,
  }),
);
