import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { RemoveConnectionFromAllGroups } from "./RemoveConnectionFromAllGroups.ts";

/**
 * Implementation of {@link RemoveConnectionFromAllGroups} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubGroupWriteRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.RemoveConnectionFromAllGroups
 */
export const RemoveConnectionFromAllGroupsHttp = Layer.effect(
  RemoveConnectionFromAllGroups,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.RemoveConnectionFromAllGroups",
    operation: webpubsub.RemoveConnectionFromAllGroups,
    grant: WebPubSubRole.GroupWrite,
  }),
);
