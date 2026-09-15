import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const waitUntilGone = (name: string) =>
  pubsub.getProjectsSubscriptions({ subscription: name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const getSubscription = (name: string) =>
  pubsub.getProjectsSubscriptions({ subscription: name }).pipe(
    Effect.retry({
      while: (error) => error._tag === "NotFound",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

const pullUntilMessage = (name: string) =>
  pubsub
    .pullProjectsSubscriptions({
      subscription: name,
      body: { maxMessages: 1, returnImmediately: true },
    })
    .pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (response) => (response.receivedMessages?.length ?? 0) > 0,
        times: 10,
      }),
    );

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("Events", {
            labels: { env: "test" },
          });
          const subscription = yield* GCP.PubSub.Subscription("Orders", {
            topic: topic.name,
            labels: { env: "test" },
          });
          return { topic, subscription };
        }),
      );

      expect(created.subscription.name).toContain("/subscriptions/");
      expect(created.subscription.subscriptionId).toEqual(expect.any(String));
      expect(created.subscription.topic).toEqual(created.topic.name);
      expect(created.subscription.labels).toMatchObject({ env: "test" });
      expect(created.subscription.ackDeadlineSeconds).toEqual(10);

      const fetched = yield* getSubscription(created.subscription.name);
      expect(fetched.name).toEqual(created.subscription.name);
      expect(fetched.topic).toEqual(created.topic.name);
      expect(fetched.labels?.env).toEqual("test");

      yield* pubsub.publishProjectsTopics({
        topic: created.topic.name,
        body: { messages: [{ data: btoa("hello-pubsub") }] },
      });

      const pulled = yield* pullUntilMessage(created.subscription.name);
      const received = pulled.receivedMessages ?? [];
      expect(received.length).toBeGreaterThan(0);
      const ackId = received[0]?.ackId;
      expect(ackId).toEqual(expect.any(String));
      if (ackId !== undefined) {
        yield* pubsub.acknowledgeProjectsSubscriptions({
          subscription: created.subscription.name,
          body: { ackIds: [ackId] },
        });
      }

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("Events", {
            topicId: created.topic.topicId,
            labels: { env: "test" },
          });
          const subscription = yield* GCP.PubSub.Subscription("Orders", {
            subscriptionId: created.subscription.subscriptionId,
            topic: topic.name,
            labels: { env: "prod", role: "orders" },
            ackDeadlineSeconds: 30,
            messageRetentionDuration: "86400s",
          });
          return { topic, subscription };
        }),
      );

      expect(updated.subscription.name).toEqual(created.subscription.name);
      expect(updated.subscription.topic).toEqual(created.topic.name);
      expect(updated.subscription.labels).toMatchObject({
        env: "prod",
        role: "orders",
      });
      expect(updated.subscription.ackDeadlineSeconds).toEqual(30);
      expect(updated.subscription.messageRetentionDuration).toEqual("86400s");

      const fetchedUpdated = yield* getSubscription(updated.subscription.name);
      expect(fetchedUpdated.ackDeadlineSeconds).toEqual(30);
      expect(fetchedUpdated.labels?.env).toEqual("prod");
      expect(fetchedUpdated.labels?.role).toEqual("orders");
      expect(fetchedUpdated.messageRetentionDuration).toEqual("86400s");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.subscription.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
