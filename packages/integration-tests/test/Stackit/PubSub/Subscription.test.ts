import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { observeSubscription, observeTopic, untilActive, untilGone } from "./pubsub.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("pubsub", "subscription"), timeout: 300_000 } as const;

const place = stackitEnvironment.pipe(
  Effect.map((env) => ({ projectId: env.projectId, regionId: env.region })),
);

test.provider(
  "create, update and delete a subscription",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* place;
      yield* stack.destroy();

      const program = (props: Omit<Stackit.PubSub.SubscriptionProps, "topicId">) =>
        Effect.gen(function* () {
          const topic = yield* Stackit.PubSub.Topic("SubscriptionTopic", {});
          const subscription = yield* Stackit.PubSub.Subscription("BasicSubscription", {
            topicId: topic.topicId,
            ...props,
          });
          return { topic, subscription };
        });

      const initial = {
        description: "alchemy test subscription",
        ackDeadline: "60s",
        labels: { env: "test" },
      };
      const { topic, subscription: created } = yield* stack.deploy(program(initial));

      expect(created.subscriptionId).toEqual(expect.any(String));
      expect(created.topicId).toEqual(topic.topicId);
      expect(created.state).toEqual("active");
      expect(created.description).toEqual("alchemy test subscription");
      expect(created.labels).toEqual({ env: "test" });

      // Out of band: the settings and Alchemy's ownership labels.
      const fetched = yield* pubsub.getSubscription({
        ...scope,
        topicId: topic.topicId,
        subscriptionId: created.subscriptionId,
      });
      expect(fetched.topicId).toEqual(topic.topicId);
      expect(fetched.labels).toMatchObject({ env: "test", "alchemy.id": "BasicSubscription" });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(program(initial));
      expect(plan.resources.BasicSubscription).toMatchObject({ action: "noop" });

      // Update every mutable aspect in place.
      const { subscription: updated } = yield* stack.deploy(
        program({
          displayName: "alchemy-test-sub-renamed",
          description: "alchemy test subscription, updated",
          ackDeadline: "5m",
          labels: { env: "stage" },
        }),
      );
      expect(updated.subscriptionId).toEqual(created.subscriptionId);
      expect(updated.displayName).toEqual("alchemy-test-sub-renamed");
      expect(updated.labels).toEqual({ env: "stage" });

      const changed = yield* pubsub.getSubscription({
        ...scope,
        topicId: topic.topicId,
        subscriptionId: created.subscriptionId,
      });
      expect(changed.displayName).toEqual("alchemy-test-sub-renamed");
      expect(changed.description).toEqual("alchemy test subscription, updated");

      yield* stack.destroy();

      const gone = yield* untilGone(
        observeSubscription(scope, topic.topicId, created.subscriptionId),
      );
      expect(gone).toEqual("gone");
      const topicGone = yield* untilGone(observeTopic(scope, topic.topicId));
      expect(topicGone).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "moving a subscription to another topic replaces it and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* place;
      yield* stack.destroy();

      const program = (useSecond: boolean) =>
        Effect.gen(function* () {
          const first = yield* Stackit.PubSub.Topic("MoveTopicA", {});
          const second = yield* Stackit.PubSub.Topic("MoveTopicB", {});
          const subscription = yield* Stackit.PubSub.Subscription("MovedSubscription", {
            topicId: useSecond ? second.topicId : first.topicId,
          });
          return { first, second, subscription };
        });

      const before = yield* stack.deploy(program(false));
      expect(before.subscription.topicId).toEqual(before.first.topicId);

      const after = yield* stack.deploy(program(true));
      expect(after.subscription.topicId).toEqual(after.second.topicId);
      expect(after.subscription.subscriptionId).not.toEqual(before.subscription.subscriptionId);

      const oldGone = yield* untilGone(
        observeSubscription(scope, before.first.topicId, before.subscription.subscriptionId),
      );
      expect(oldGone).toEqual("gone");
      const live = yield* pubsub.getSubscription({
        ...scope,
        topicId: after.second.topicId,
        subscriptionId: after.subscription.subscriptionId,
      });
      expect(live.topicId).toEqual(after.second.topicId);

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "a foreign subscription with the same display name is not taken over",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* place;
      yield* stack.destroy();

      const displayName = "alchemy-test-sub-foreign";
      const topic = yield* stack.deploy(Stackit.PubSub.Topic("ForeignSubscriptionTopic", {}));
      const foreign = yield* pubsub.createSubscription({
        ...scope,
        topicId: topic.topicId,
        displayName,
      });
      yield* untilActive(observeSubscription(scope, topic.topicId, foreign.id));

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const owner = yield* Stackit.PubSub.Topic("ForeignSubscriptionTopic", {});
            return yield* Stackit.PubSub.Subscription("ForeignSubscription", {
              topicId: owner.topicId,
              displayName,
            });
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      const after = yield* pubsub.getSubscription({
        ...scope,
        topicId: topic.topicId,
        subscriptionId: foreign.id,
      });
      expect(after.displayName).toEqual(displayName);

      // The topic won't be deleted over a subscription that isn't in the stack.
      yield* pubsub.deleteSubscription({
        ...scope,
        topicId: topic.topicId,
        subscriptionId: foreign.id,
      });
      yield* untilGone(observeSubscription(scope, topic.topicId, foreign.id));
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
