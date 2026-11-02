import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { subscribersOf } from "./pubsub.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("pubsub", "subscriptionsubscriberaccess"),
  timeout: 300_000,
} as const;

const place = stackitEnvironment.pipe(
  Effect.map((env) => ({ projectId: env.projectId, regionId: env.region })),
);

test.provider(
  "granting and removing one subscriber keeps the others",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* place;
      yield* stack.destroy();

      const program = (grantBoth: boolean) =>
        Effect.gen(function* () {
          const topic = yield* Stackit.PubSub.Topic("SubscriberTopic", {});
          const subscription = yield* Stackit.PubSub.Subscription("SubscriberSubscription", {
            topicId: topic.topicId,
          });
          const first = yield* Stackit.IAM.ServiceAccount("SubscriberA", {});
          const second = yield* Stackit.IAM.ServiceAccount("SubscriberB", {});
          const outsider = yield* Stackit.IAM.ServiceAccount("SubscriberOutsider", {});
          yield* Stackit.PubSub.SubscriptionSubscriberAccess("FirstPulls", {
            topicId: topic.topicId,
            subscriptionId: subscription.subscriptionId,
            emailAddress: first.email,
          });
          if (grantBoth) {
            yield* Stackit.PubSub.SubscriptionSubscriberAccess("SecondPulls", {
              topicId: topic.topicId,
              subscriptionId: subscription.subscriptionId,
              emailAddress: second.email,
            });
          }
          return { topic, subscription, first, second, outsider };
        });

      const both = yield* stack.deploy(program(true));
      const topicId = both.topic.topicId;
      const subscriptionId = both.subscription.subscriptionId;
      const firstEmail = both.first.email.toLowerCase();
      const secondEmail = both.second.email.toLowerCase();
      const listed = yield* subscribersOf(scope, topicId, subscriptionId);
      expect(listed).toContain(firstEmail);
      expect(listed).toContain(secondEmail);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(program(true));
      expect(plan.resources.FirstPulls).toMatchObject({ action: "noop" });

      // An address someone else added survives everything below.
      const foreign = both.outsider.email.toLowerCase();
      yield* pubsub.grantSubscriptionSubscriberAccess({
        ...scope,
        topicId,
        subscriptionId,
        emailAddress: foreign,
      });
      yield* subscribersOf(scope, topicId, subscriptionId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (emails) => emails.includes(foreign),
          times: 20,
        }),
      );

      // Removing one grant removes exactly that address.
      yield* stack.deploy(program(false));
      const after = yield* subscribersOf(scope, topicId, subscriptionId);
      expect(after).toContain(firstEmail);
      expect(after).toContain(foreign);
      expect(after).not.toContain(secondEmail);

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
