import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export const BindingsTopic = Stackit.PubSub.Topic("PubSubBindingsTopic", {});

/** A short deadline, so a redelivery shows up within a test. */
export const BindingsSubscription = BindingsTopic.pipe(
  Effect.flatMap((topic) =>
    Stackit.PubSub.Subscription("PubSubBindingsSubscription", {
      topicId: topic.topicId,
      ackDeadline: "10s",
    }),
  ),
);

/**
 * A Cloudflare Worker with every Pub/Sub binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class PubSubBindingsWorker extends Cloudflare.Worker<PubSubBindingsWorker>()(
  "StackitPubSubBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const topic = yield* BindingsTopic;
    const subscription = yield* BindingsSubscription;
    const getTopic = yield* Stackit.PubSub.GetTopic(topic);
    const listTopics = yield* Stackit.PubSub.ListTopics(topic);
    const createSubscription = yield* Stackit.PubSub.CreateSubscription(topic);
    const deleteSubscription = yield* Stackit.PubSub.DeleteSubscription(topic);
    const getSubscription = yield* Stackit.PubSub.GetSubscription(subscription);
    const listSubscriptions = yield* Stackit.PubSub.ListSubscriptions(topic);
    const listTopicPublishers = yield* Stackit.PubSub.ListTopicPublishers(topic);
    const listSubscriptionSubscribers =
      yield* Stackit.PubSub.ListSubscriptionSubscribers(subscription);
    const publish = yield* Stackit.PubSub.Publish(topic);
    const purgeTopic = yield* Stackit.PubSub.PurgeTopic(topic);
    const pull = yield* Stackit.PubSub.Pull(subscription);
    const acknowledge = yield* Stackit.PubSub.Acknowledge(subscription);
    const negativeAcknowledge = yield* Stackit.PubSub.NegativeAcknowledge(subscription);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/get-topic":
            return yield* respond(getTopic());
          case "/list-topics":
            return yield* respond(listTopics({ pageSize: 100 }));
          case "/create-subscription":
            return yield* respond(createSubscription({ displayName: param("name") }));
          case "/delete-subscription":
            return yield* respond(deleteSubscription({ subscriptionId: param("id") }));
          case "/get-subscription":
            return yield* respond(getSubscription());
          case "/list-subscriptions":
            return yield* respond(listSubscriptions({ pageSize: 100 }));
          case "/list-topic-publishers":
            return yield* respond(listTopicPublishers());
          case "/list-subscription-subscribers":
            return yield* respond(listSubscriptionSubscribers());
          case "/publish":
            return yield* respond(publish({ messages: [{ data: param("text") }] }));
          case "/publish-bytes":
            return yield* respond(
              publish({ messages: [{ data: new TextEncoder().encode(param("text")) }] }),
            );
          case "/purge":
            return yield* respond(purgeTopic());
          case "/pull":
            return yield* respond(pull({ maxMessages: 32, longPullDuration: 1000 }));
          case "/ack":
            return yield* respond(acknowledge({ ackIds: param("ids").split(",") }));
          case "/nack":
            return yield* respond(negativeAcknowledge({ nackIds: param("ids").split(",") }));
          default:
            return HttpServerResponse.text("ok");
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.PubSub.GetTopicHttp,
        Stackit.PubSub.ListTopicsHttp,
        Stackit.PubSub.CreateSubscriptionHttp,
        Stackit.PubSub.DeleteSubscriptionHttp,
        Stackit.PubSub.GetSubscriptionHttp,
        Stackit.PubSub.ListSubscriptionsHttp,
        Stackit.PubSub.ListTopicPublishersHttp,
        Stackit.PubSub.ListSubscriptionSubscribersHttp,
        Stackit.PubSub.PublishHttp,
        Stackit.PubSub.PurgeTopicHttp,
        Stackit.PubSub.PullHttp,
        Stackit.PubSub.AcknowledgeHttp,
        Stackit.PubSub.NegativeAcknowledgeHttp,
      ),
    ),
  ),
) {}
