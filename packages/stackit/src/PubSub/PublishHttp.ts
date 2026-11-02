import * as Layer from "effect/Layer";
import { makeTopicDataHttpBinding, publishOperation } from "./BindingHttp.ts";
import { Publish } from "./Publish.ts";

/**
 * HTTP implementation of {@link Publish}.
 *
 * @layer
 * @provides Stackit.PubSub.Publish
 */
export const PublishHttp = Layer.effect(
  Publish,
  makeTopicDataHttpBinding({
    tag: "Stackit.PubSub.Publish",
    operation: publishOperation,
  }),
);
