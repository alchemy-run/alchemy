import * as Docker from "@alchemy.run/docker";
import * as Stackit from "@alchemy.run/stackit";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** Host port the swarm publishes the consumer on. Fixed, and uncommon on a shared daemon. */
export const CONSUMER_EXTERNAL_PORT = 43219;

/** A message with this text fails on its first delivery. */
export const FAIL_ONCE = "fail once";

export const ConsumerTopic = Stackit.PubSub.Topic("PubSubConsumerTopic", {});

export const ConsumerSubscription = ConsumerTopic.pipe(
  Effect.flatMap((topic) =>
    Stackit.PubSub.Subscription("PubSubConsumerSubscription", {
      topicId: topic.topicId,
      ackDeadline: "30s",
    }),
  ),
);

/**
 * A long-lived host with the event source: pulling needs a process that keeps running,
 * which a Worker isn't. `/received` reports what the handler saw, and `/publish` publishes.
 */
export default class PubSubConsumer extends Docker.Service<PubSubConsumer>()(
  "StackitPubSubConsumer",
  {
    main: import.meta.filename,
    port: 3000,
    ports: [{ external: CONSUMER_EXTERNAL_PORT, internal: 3000 }],
    replicas: 1,
  },
  Effect.gen(function* () {
    const topic = yield* ConsumerTopic;
    const subscription = yield* ConsumerSubscription;
    const publish = yield* Stackit.PubSub.Publish(topic);
    const received: Array<{ text: string; deliveryAttempts: number }> = [];

    yield* Stackit.PubSub.consumeSubscriptionMessages(
      subscription,
      { maxMessages: 5, longPullDuration: 2000 },
      (message) =>
        Effect.gen(function* () {
          received.push({ text: message.text, deliveryAttempts: message.deliveryAttempts });
          if (message.text === FAIL_ONCE && message.deliveryAttempts === 1) {
            return yield* Effect.fail("failing the first delivery");
          }
        }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://service");
        switch (url.pathname) {
          case "/received":
            return yield* HttpServerResponse.json({ received });
          case "/publish":
            return yield* publish({
              messages: [{ data: url.searchParams.get("text") ?? "" }],
            }).pipe(
              Effect.flatMap(() => HttpServerResponse.json({ ok: true })),
              Effect.catchCause((cause) =>
                HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
              ),
            );
          default:
            return HttpServerResponse.text("ok");
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Stackit.PubSub.PublishHttp, Stackit.PubSub.ServerSubscriptionEventSource),
    ),
  ),
) {}
