import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  entitlementTags,
  hasGcpCreds,
  logLevel,
  probeTopics,
  runLifecycle,
  zone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!runLifecycle)(
  "GetTopic, GetPartitions, and ComputeHeadCursor round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* probeTopics();
      if (probe.tag !== "ok") {
        expect([...entitlementTags]).toContain(probe.tag);
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.Pubsublite.AdminTopic("Events", {
            location: zone,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* topic.name;
              const getTopic = yield* GCP.Pubsublite.GetTopic(topic);
              const getPartitions = yield* GCP.Pubsublite.GetPartitions(topic);
              const computeHead =
                yield* GCP.Pubsublite.ComputeHeadCursor(topic);
              return Effect.fn(function* () {
                const live = yield* getTopic();
                const partitions = yield* getPartitions();
                const head = yield* computeHead({
                  body: { partition: "0" },
                });
                return { live, partitions, head };
              });
            }),
          );
          return { topic, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.topic.name);
      expect(out.probe.partitions.partitionCount).toEqual("1");
      expect(out.probe.head.headCursor?.offset).toEqual(expect.any(String));

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetSubscription and CommitCursor on a subscription",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* probeTopics();
      if (probe.tag !== "ok") {
        expect([...entitlementTags]).toContain(probe.tag);
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.Pubsublite.AdminTopic("Events", {
            location: zone,
          });
          const subscription = yield* GCP.Pubsublite.AdminSubscription(
            "Inbox",
            {
              location: zone,
              topic: topic.name,
            },
          );
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* subscription.name;
              const getSubscription =
                yield* GCP.Pubsublite.GetSubscription(subscription);
              const commit = yield* GCP.Pubsublite.CommitCursor(subscription);
              return Effect.fn(function* () {
                const live = yield* getSubscription();
                const committed = yield* commit({
                  body: { partition: "0", cursor: { offset: "0" } },
                });
                return { live, committed };
              });
            }),
          );
          return {
            subscription,
            probe: yield* Probe({}),
          };
        }),
      );

      expect(out.probe.live.name).toEqual(out.subscription.name);
      expect(out.probe.committed).toEqual(expect.any(Object));

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
