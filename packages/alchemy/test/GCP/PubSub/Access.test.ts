import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider(
  "WriteTopic and ReadSubscription clients",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* GCP.PubSub.Topic("Events", {});
          const subscription = yield* GCP.PubSub.Subscription("Inbox", {
            topic: topic.name,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* subscription.name;
              const events = yield* GCP.PubSub.WriteTopic(topic);
              const inbox = yield* GCP.PubSub.ReadSubscription(subscription);
              return Effect.fn(function* () {
                const id = yield* events.publish({
                  data: "hello",
                  attributes: { kind: "greeting" },
                });
                const batch = yield* events.publishBatch([
                  { data: new Uint8Array([0, 1, 255]) },
                  { data: "bye" },
                ]);
                const empty = yield* events.publishBatch([]);
                // Pub/Sub returns partial pulls; accumulate until all 3 land.
                const all: GCP.PubSub.PulledMessage[] = [];
                yield* inbox.pull({ maxMessages: 10 }).pipe(
                  Effect.tap((messages) =>
                    inbox.acknowledge(messages.map((m) => m.ackId)),
                  ),
                  Effect.map((messages) => all.push(...messages)),
                  Effect.repeat({
                    schedule: Schedule.spaced("1 second"),
                    until: (count) => count >= 3,
                    times: 15,
                  }),
                );
                yield* inbox.modifyAckDeadline([], 0);
                yield* inbox.acknowledge([]);
                const afterAck = yield* inbox.pull({
                  maxMessages: 10,
                  returnImmediately: true,
                });
                const byId = new Map(all.map((m) => [m.messageId, m]));
                const hello = byId.get(id);
                const binary = byId.get(batch[0]!);
                const bye = byId.get(batch[1]!);
                return {
                  batchIds: batch.length,
                  empty,
                  hello: hello?.text,
                  helloAttributes: hello?.attributes,
                  binary: binary && [...binary.data],
                  bye: bye?.text,
                  byeAttributes: bye?.attributes,
                  afterAck: afterAck.length,
                };
              });
            }).pipe(
              Effect.provide(GCP.PubSub.WriteTopicHttp),
              Effect.provide(GCP.PubSub.ReadSubscriptionHttp),
            ),
          );
          return { probe: yield* Probe({}) };
        }),
      );

      expect(out.probe).toEqual({
        batchIds: 2,
        empty: [],
        hello: "hello",
        helloAttributes: { kind: "greeting" },
        binary: [0, 1, 255],
        bye: "bye",
        byeAttributes: {},
        afterAck: 0,
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);
