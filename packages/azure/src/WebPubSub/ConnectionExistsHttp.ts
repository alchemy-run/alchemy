import * as webpubsub from "@distilled.cloud/azure/webpubsub-data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeHubOperationBinding, WebPubSubRole } from "./BindingHttp.ts";
import { ConnectionExists } from "./ConnectionExists.ts";

/**
 * Implementation of {@link ConnectionExists} over the distilled `webpubsub-data`
 * data plane. Assigns the custom `AzureWebPubSubConnectionReadRole` on the hub's
 * service.
 *
 * @layer
 * @provides Azure.WebPubSub.ConnectionExists
 */
export const ConnectionExistsHttp = Layer.effect(
  ConnectionExists,
  makeHubOperationBinding({
    tag: "Azure.WebPubSub.ConnectionExists",
    operation: webpubsub.ConnectionExists,
    grant: WebPubSubRole.ConnectionRead,
    // The service answers 404 for `false`.
    finish: (check) =>
      check.pipe(
        Effect.as(true),
        Effect.catchTag("WebPubSubConnectionNotFound", () => Effect.succeed(false)),
      ),
  }),
);
