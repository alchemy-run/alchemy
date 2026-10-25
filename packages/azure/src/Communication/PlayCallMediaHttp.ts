import * as callAutomation from "@distilled.cloud/azure/communication-call-automation";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { PlayCallMedia } from "./PlayCallMedia.ts";

/**
 * Implementation of {@link PlayCallMedia} over the distilled
 * `communication-call-automation` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.PlayCallMedia
 */
export const PlayCallMediaHttp = Layer.effect(
  PlayCallMedia,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.PlayCallMedia",
    operation: callAutomation.CallMediaPlay,
    grant: CommunicationRole.Data,
  }),
);
