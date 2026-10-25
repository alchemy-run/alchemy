import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { UpdateChatThreadProperties } from "./UpdateChatThreadProperties.ts";

/**
 * Implementation of {@link UpdateChatThreadProperties} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.UpdateChatThreadProperties
 */
export const UpdateChatThreadPropertiesHttp = Layer.effect(
  UpdateChatThreadProperties,
  makeChatHttpBinding({
    tag: "Azure.Communication.UpdateChatThreadProperties",
    operation: chat.UpdateChatThreadChatThreadProperties,
  }),
);
