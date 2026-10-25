import * as messages from "@distilled.cloud/azure/communication-messages";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetMessageMedia } from "./GetMessageMedia.ts";

/**
 * Implementation of {@link GetMessageMedia} over the distilled
 * `communication-messages` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetMessageMedia
 */
export const GetMessageMediaHttp = Layer.effect(
  GetMessageMedia,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetMessageMedia",
    operation: messages.GetStreamOperationMedia,
    grant: CommunicationRole.Data,
  }),
);
