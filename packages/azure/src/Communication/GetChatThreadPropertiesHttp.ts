import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { GetChatThreadProperties } from "./GetChatThreadProperties.ts";

/**
 * Implementation of {@link GetChatThreadProperties} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.GetChatThreadProperties
 */
export const GetChatThreadPropertiesHttp = Layer.effect(
  GetChatThreadProperties,
  makeChatHttpBinding({
    tag: "Azure.Communication.GetChatThreadProperties",
    operation: chat.GetChatThreadChatThreadProperties,
  }),
);
