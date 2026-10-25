import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { RemoveUserFromAllGroups } from "./RemoveUserFromAllGroups.ts";

/**
 * Implementation of {@link RemoveUserFromAllGroups} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubGroupWriteRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.RemoveUserFromAllGroups
 */
export const RemoveUserFromAllGroupsHttp = Layer.effect(
  RemoveUserFromAllGroups,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.RemoveUserFromAllGroups",
    operation: webpubsub.RemoveUserFromAllGroups,
    grant: WebPubSubRole.GroupWrite,
  }),
);
