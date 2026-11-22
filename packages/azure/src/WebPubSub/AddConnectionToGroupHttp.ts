import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { AddConnectionToGroup } from "./AddConnectionToGroup.ts";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddConnectionToGroup} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubGroupWriteRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.AddConnectionToGroup
 */
export const AddConnectionToGroupHttp = Layer.effect(
  AddConnectionToGroup,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.AddConnectionToGroup",
    operation: webpubsub.AddConnectionToGroup,
    grant: WebPubSubRole.GroupWrite,
  }),
);
