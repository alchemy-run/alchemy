import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { GroupExists } from "./GroupExists.ts";

/**
 * Implementation of {@link GroupExists} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubGroupReadRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.GroupExists
 */
export const GroupExistsHttp = Layer.effect(
  GroupExists,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.GroupExists",
    operation: webpubsub.GroupExists,
    grant: WebPubSubRole.GroupRead,
    // The service answers 404 for `false`.
    finish: (check) =>
      check.pipe(
        Effect.as(true),
        Effect.catchTag("WebPubSubGroupNotFound", () => Effect.succeed(false)),
      ),
  }),
);
