import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTopicHttpBinding } from "./BindingHttp.ts";
import type { Topic } from "./Topic.ts";

export interface PublishRequest extends Omit<pubsub.PublishProjectsTopicsRequest, "topic"> {}

/**
 * Runtime binding for Pub/Sub `topics.publish`.
 *
 * Bind this operation to a {@link Topic} in a Function/Action init phase.
 * Provide {@link PublishHttp}.
 *
 * ### Publishing Messages
 * **Example:** Publish a message
 * ```typescript
 * const publish = yield* GCP.PubSub.Publish(topic);
 * const { messageIds } = yield* publish({
 *   body: { messages: [{ data: btoa("hello") }] },
 * });
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface Publish extends Binding.Service<
  Publish,
  "GCP.PubSub.Publish",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: PublishRequest,
    ) => Effect.Effect<pubsub.PublishResponse, pubsub.PublishProjectsTopicsError, RuntimeContext>
  >
> {}

export const Publish = Binding.Service<Publish>("GCP.PubSub.Publish");

/**
 * HTTP implementation of {@link Publish}.
 *
 * @layer
 * @provides GCP.PubSub.Publish
 */
export const PublishHttp = Layer.effect(
  Publish,
  makeTopicHttpBinding({
    tag: "GCP.PubSub.Publish",
    iam: { role: "roles/pubsub.publisher", on: "pubsub.topic" },
    operation: pubsub.publishProjectsTopics,
  }),
);
