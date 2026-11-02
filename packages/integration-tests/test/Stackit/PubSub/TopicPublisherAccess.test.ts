import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { publishersOf } from "./pubsub.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("pubsub", "topicpublisheraccess"), timeout: 300_000 } as const;

const place = stackitEnvironment.pipe(
  Effect.map((env) => ({ projectId: env.projectId, regionId: env.region })),
);

test.provider(
  "granting and removing one publisher keeps the others",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* place;
      yield* stack.destroy();

      const program = (grantBoth: boolean) =>
        Effect.gen(function* () {
          const topic = yield* Stackit.PubSub.Topic("AccessTopic", {});
          const first = yield* Stackit.IAM.ServiceAccount("PublisherA", {});
          const second = yield* Stackit.IAM.ServiceAccount("PublisherB", {});
          const outsider = yield* Stackit.IAM.ServiceAccount("PublisherOutsider", {});
          yield* Stackit.PubSub.TopicPublisherAccess("FirstPublishes", {
            topicId: topic.topicId,
            emailAddress: first.email,
          });
          if (grantBoth) {
            yield* Stackit.PubSub.TopicPublisherAccess("SecondPublishes", {
              topicId: topic.topicId,
              emailAddress: second.email,
            });
          }
          return { topic, first, second, outsider };
        });

      const both = yield* stack.deploy(program(true));
      const firstEmail = both.first.email.toLowerCase();
      const secondEmail = both.second.email.toLowerCase();
      const listed = yield* publishersOf(scope, both.topic.topicId);
      expect(listed).toContain(firstEmail);
      expect(listed).toContain(secondEmail);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(program(true));
      expect(plan.resources.FirstPublishes).toMatchObject({ action: "noop" });

      // An address someone else added survives everything below.
      const foreign = both.outsider.email.toLowerCase();
      yield* pubsub.grantTopicPublisherAccess({
        ...scope,
        topicId: both.topic.topicId,
        emailAddress: foreign,
      });
      yield* publishersOf(scope, both.topic.topicId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (emails) => emails.includes(foreign),
          times: 20,
        }),
      );

      // Removing one grant removes exactly that address.
      yield* stack.deploy(program(false));
      const after = yield* publishersOf(scope, both.topic.topicId);
      expect(after).toContain(firstEmail);
      expect(after).toContain(foreign);
      expect(after).not.toContain(secondEmail);

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "an address already on the list without state is not taken over",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* place;
      yield* stack.destroy();

      const { topic, outsider } = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* Stackit.PubSub.Topic("ListedAccessTopic", {});
          const outsider = yield* Stackit.IAM.ServiceAccount("ListedOutsider", {});
          return { topic, outsider };
        }),
      );
      const foreign = outsider.email.toLowerCase();
      yield* pubsub.grantTopicPublisherAccess({
        ...scope,
        topicId: topic.topicId,
        emailAddress: foreign,
      });
      yield* publishersOf(scope, topic.topicId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (emails) => emails.includes(foreign),
          times: 20,
        }),
      );

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const owner = yield* Stackit.PubSub.Topic("ListedAccessTopic", {});
            yield* Stackit.IAM.ServiceAccount("ListedOutsider", {});
            return yield* Stackit.PubSub.TopicPublisherAccess("ListedPublishes", {
              topicId: owner.topicId,
              emailAddress: foreign,
            });
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");
      const listed = yield* publishersOf(scope, topic.topicId);
      expect(listed).toContain(foreign);

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
