import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as AzureBindings from "../AzureBindings.ts";
import { type HubAt, makeHubBinding, WebPubSubRole } from "./BindingHttp.ts";
import {
  ListConnectionsInGroup,
  type ListConnectionsInGroupRequest,
} from "./ListConnectionsInGroup.ts";

/**
 * Implementation of {@link ListConnectionsInGroup} over the distilled
 * `webpubsub-data` data plane; reads every page. Assigns the custom
 * `AzureWebPubSubGroupReadRole` on the hub's service.
 *
 * @layer
 * @provides Azure.WebPubSub.ListConnectionsInGroup
 */
export const ListConnectionsInGroupHttp = Layer.effect(
  ListConnectionsInGroup,
  makeHubBinding({
    tag: "Azure.WebPubSub.ListConnectionsInGroup",
    grant: WebPubSubRole.GroupRead,
    makeClient: Effect.gen(function* () {
      const list = yield* AzureBindings.withCredentials(webpubsub.ListConnectionsInGroup);
      return (name: string, at: HubAt) =>
        Effect.fn(name)(function* (request: ListConnectionsInGroupRequest) {
          const where = yield* at;
          const members = yield* Stream.runCollect(list.items({ ...request, ...where }));
          return Array.from(members);
        });
    }),
  }),
);
