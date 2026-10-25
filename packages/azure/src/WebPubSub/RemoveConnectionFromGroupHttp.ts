import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { RemoveConnectionFromGroup } from "./RemoveConnectionFromGroup.ts";

/**
 * Implementation of {@link RemoveConnectionFromGroup} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubGroupWriteRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.RemoveConnectionFromGroup
 */
export const RemoveConnectionFromGroupHttp = Layer.effect(
  RemoveConnectionFromGroup,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.RemoveConnectionFromGroup",
    operation: webpubsub.RemoveConnectionFromGroup,
    grant: WebPubSubRole.GroupWrite,
  }),
);
