import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { observeSubscription, observeTopic, untilActive, untilGone } from "./pubsub.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("pubsub", "topic"), timeout: 300_000 } as const;

const place = stackitEnvironment.pipe(
  Effect.map((env) => ({ projectId: env.projectId, regionId: env.region })),
);

test.provider(
  "create, update and delete a topic",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* place;
      yield* stack.destroy();

      const props = {
        description: "alchemy test topic",
        retention: "24h",
        labels: { env: "test", keep: "yes" },
      };
      const created = yield* stack.deploy(Stackit.PubSub.Topic("BasicTopic", props));

      expect(created.topicId).toEqual(expect.any(String));
      expect(created.projectId).toEqual(scope.projectId);
      expect(created.region).toEqual(scope.regionId);
      expect(created.state).toEqual("active");
      expect(created.displayName.length).toBeLessThanOrEqual(36);
      expect(created.displayName).toMatch(/^[a-zA-Z0-9 -]+$/);
      expect(created.description).toEqual("alchemy test topic");
      expect(created.labels).toEqual({ env: "test", keep: "yes" });

      // Out of band: the settings and Alchemy's ownership labels.
      const fetched = yield* pubsub.getTopic({ ...scope, topicId: created.topicId });
      expect(fetched.state).toEqual("active");
      expect(fetched.labels).toMatchObject({
        env: "test",
        keep: "yes",
        "alchemy.id": "BasicTopic",
      });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.PubSub.Topic("BasicTopic", props));
      expect(plan.resources.BasicTopic).toMatchObject({ action: "noop" });

      // Update every mutable aspect in place.
      const updated = yield* stack.deploy(
        Stackit.PubSub.Topic("BasicTopic", {
          displayName: "alchemy-test-topic-renamed",
          description: "alchemy test topic, updated",
          retention: "12h",
          acl: ["203.0.113.0/24", "198.51.100.0/24"],
          metrics: true,
          serviceLogs: true,
          labels: { env: "stage" },
        }),
      );
      expect(updated.topicId).toEqual(created.topicId);
      expect(updated.displayName).toEqual("alchemy-test-topic-renamed");
      expect(updated.settings.metrics).toEqual(true);
      expect(updated.settings.serviceLogs).toEqual(true);
      expect(updated.labels).toEqual({ env: "stage" });

      const changed = yield* pubsub.getTopic({ ...scope, topicId: created.topicId });
      expect(changed.displayName).toEqual("alchemy-test-topic-renamed");
      expect(changed.description).toEqual("alchemy test topic, updated");
      expect([...(changed.settings?.acl ?? [])].sort()).toEqual([
        "198.51.100.0/24",
        "203.0.113.0/24",
      ]);
      expect(changed.settings?.metrics).toEqual(true);
      expect(changed.settings?.serviceLogs).toEqual(true);

      // A prop that is no longer set leaves its neighbours and the live value alone.
      const partial = yield* stack.deploy(
        Stackit.PubSub.Topic("BasicTopic", {
          displayName: "alchemy-test-topic-renamed",
          retention: "6h",
        }),
      );
      expect(partial.settings.metrics).toEqual(true);
      expect(partial.settings.acl.length).toEqual(2);
      expect(partial.description).toEqual("alchemy test topic, updated");

      yield* stack.destroy();

      // Out of band: gone.
      const gone = yield* untilGone(observeTopic(scope, created.topicId));
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "a topic is listed with its labels across pages",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* place;
      yield* stack.destroy();

      const created = yield* stack.deploy(Stackit.PubSub.Topic("ListedTopic", {}));

      const listed = yield* pubsub.listTopics
        .items({ ...scope, pageSize: 1 })
        .pipe(Stream.runCollect);
      const found = [...listed].find((topic) => topic.id === created.topicId);
      expect(found?.labels).toMatchObject({ "alchemy.id": "ListedTopic" });

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);

test.provider(
  "a subscription made out of band stops the destroy, and survives it",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* place;
      yield* stack.destroy();

      const topic = yield* stack.deploy(Stackit.PubSub.Topic("GuardedTopic", {}));
      const foreign = yield* pubsub.createSubscription({
        ...scope,
        topicId: topic.topicId,
        displayName: "alchemy-test-runtime-made",
      });
      const settled = yield* untilActive(observeSubscription(scope, topic.topicId, foreign.id));
      expect(settled).toMatchObject({ state: "active" });

      const refused = yield* stack.destroy().pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "Stackit.PubSub.TopicNotEmpty",
        subscriptions: ["alchemy-test-runtime-made"],
      });

      // Neither was touched.
      const topicAfter = yield* observeTopic(scope, topic.topicId);
      expect(topicAfter).toMatchObject({ state: "active" });
      const survivor = yield* observeSubscription(scope, topic.topicId, foreign.id);
      expect(survivor).toMatchObject({ state: "active" });

      // Once it is gone, the destroy goes through.
      yield* pubsub.deleteSubscription({
        ...scope,
        topicId: topic.topicId,
        subscriptionId: foreign.id,
      });
      yield* untilGone(observeSubscription(scope, topic.topicId, foreign.id));
      yield* stack.destroy();
      const gone = yield* untilGone(observeTopic(scope, topic.topicId));
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "forceDestroy lets a destroy remove a subscription made out of band",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* place;
      yield* stack.destroy();

      const topic = yield* stack.deploy(
        Stackit.PubSub.Topic("CascadeTopic", { forceDestroy: true }),
      );
      const foreign = yield* pubsub.createSubscription({
        ...scope,
        topicId: topic.topicId,
        displayName: "alchemy-test-runtime-made",
      });
      const settled = yield* untilActive(observeSubscription(scope, topic.topicId, foreign.id));
      expect(settled).toMatchObject({ state: "active" });

      yield* stack.destroy();

      const gone = yield* untilGone(observeTopic(scope, topic.topicId));
      expect(gone).toEqual("gone");
      const subscriptionGone = yield* untilGone(
        observeSubscription(scope, topic.topicId, foreign.id),
      );
      expect(subscriptionGone).toEqual("gone");
    }).pipe(logLevel),
  options,
);

test.provider(
  "a foreign topic with the same display name is not taken over",
  (stack) =>
    Effect.gen(function* () {
      const scope = yield* place;
      yield* stack.destroy();

      const displayName = "alchemy-test-topic-foreign";
      // It has no labels for `pnpm nuke` to find, so it goes whatever the assertions do.
      yield* Effect.acquireUseRelease(
        pubsub.createTopic({ ...scope, displayName }),
        (foreign) =>
          Effect.gen(function* () {
            yield* untilActive(observeTopic(scope, foreign.id));

            const error = yield* stack
              .deploy(
                Stackit.PubSub.Topic("ForeignTopic", { displayName, description: "taken over" }),
              )
              .pipe(Effect.flip);
            expect(error._tag).toEqual("OwnedBySomeoneElse");

            // The foreign topic was neither changed nor removed.
            const after = yield* pubsub.getTopic({ ...scope, topicId: foreign.id });
            expect(after.displayName).toEqual(displayName);
            expect(after.description).toBeUndefined();
          }),
        (foreign) =>
          pubsub
            .deleteTopic({ ...scope, topicId: foreign.id, force: true })
            .pipe(Effect.andThen(untilGone(observeTopic(scope, foreign.id))), Effect.ignore),
      );
      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
