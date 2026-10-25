import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { SendToUser } from "./SendToUser.ts";

/**
 * Implementation of {@link SendToUser} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubUserSendRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.SendToUser
 */
export const SendToUserHttp = Layer.effect(
  SendToUser,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.SendToUser",
    operation: webpubsub.SendToUser,
    grant: WebPubSubRole.UserSend,
  }),
);
