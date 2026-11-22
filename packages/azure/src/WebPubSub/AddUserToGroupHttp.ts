import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { AddUserToGroup } from "./AddUserToGroup.ts";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddUserToGroup} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubGroupWriteRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.AddUserToGroup
 */
export const AddUserToGroupHttp = Layer.effect(
  AddUserToGroup,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.AddUserToGroup",
    operation: webpubsub.AddUserToGroup,
    grant: WebPubSubRole.GroupWrite,
  }),
);
