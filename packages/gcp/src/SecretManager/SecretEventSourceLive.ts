import * as Binding from "alchemy/Binding";
import * as Namespace from "alchemy/Namespace";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Topic } from "../PubSub/Topic.ts";
import { TopicEventSource } from "../PubSub/TopicEventSource.ts";
import type { Secret } from "./Secret.ts";
import {
  SecretEventSource,
  toSecretEvent,
  type SecretEvent,
  type SecretEventSourceProps,
  type SecretEventSourceService,
} from "./SecretEventSource.ts";

/**
 * Implementation of `GCP.SecretManager.SecretEventSource` over Pub/Sub.
 *
 * Deploy-time: creates a Pub/Sub topic owned by the host
 * (`{secret}-SecretEvents`) and binds it onto the secret's notification
 * topics; the Secret provider grants the Secret Manager service agent
 * `roles/pubsub.publisher` on it. The subscription filters on the
 * requested event types. Delivery is delegated to the provided
 * `GCP.PubSub.TopicEventSource` implementation. Runtime: each message is
 * parsed into a `SecretEvent`.
 *
 * ### Choosing the delivery
 * **Example:** Push to a Cloud Run service
 * ```typescript
 * Effect.gen(function* () {
 *   yield* GCP.SecretManager.consumeSecretEvents(secret, (events) =>
 *     events.pipe(Stream.runForEach((event) => Effect.log(event.eventType))),
 *   );
 * }).pipe(
 *   Effect.provide(
 *     GCP.SecretManager.SecretEventSourceLive.pipe(Layer.provideMerge(GCP.Run.TopicEventSource)),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides GCP.SecretManager.SecretEventSource
 * @category SecretManager
 */
export const SecretEventSourceLive = Layer.effect(
  SecretEventSource,
  Effect.gen(function* () {
    const topics = yield* Topic;
    const source = yield* TopicEventSource;

    return Effect.fn(function* <Req = never>(
      secret: Secret,
      props: SecretEventSourceProps,
      handler: (events: Stream.Stream<SecretEvent>) => Effect.Effect<void, never, Req>,
    ) {
      const host = yield* Binding.Host;
      const hostId = host?.LogicalId ?? "Host";
      // Declared in both phases: the delivery implementation declares its
      // subscription against this topic at runtime too.
      const topic = yield* Namespace.push(hostId, topics(`${secret.LogicalId}-SecretEvents`, {}));

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* secret.bind`GCP.SecretManager.SecretEvents(${host}, ${secret})`({
          topics: [{ name: topic.name }],
        });
      }

      const { eventTypes, ...delivery } = props;
      yield* source(
        topic,
        {
          ...delivery,
          filter:
            eventTypes && eventTypes.length > 0
              ? eventTypes.map((type) => `attributes.eventType = "${type}"`).join(" OR ")
              : undefined,
        },
        (messages) => handler(messages.pipe(Stream.mapEffect(toSecretEvent))),
      );
    }) as SecretEventSourceService;
  }),
);
