import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { RemoveUserFromGroup } from "./RemoveUserFromGroup.ts";

/**
 * Implementation of {@link RemoveUserFromGroup} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubGroupWriteRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.RemoveUserFromGroup
 */
export const RemoveUserFromGroupHttp = Layer.effect(
  RemoveUserFromGroup,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.RemoveUserFromGroup",
    operation: webpubsub.RemoveUserFromGroup,
    grant: WebPubSubRole.GroupWrite,
  }),
);
