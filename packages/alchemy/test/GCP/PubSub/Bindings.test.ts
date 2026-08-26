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

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const AVRO = JSON.stringify({
  type: "record",
  name: "Event",
  fields: [{ name: "id", type: "string" }],
});

test.provider.skipIf(!hasGcpCreds)(
  "Publish, Pull, and Acknowledge round-trip",
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
              const publish = yield* GCP.PubSub.Publish(topic);
              const pull = yield* GCP.PubSub.Pull(subscription);
              const acknowledge = yield* GCP.PubSub.Acknowledge(subscription);
              return Effect.fn(function* () {
                const published = yield* publish({
                  body: { messages: [{ data: btoa("hello") }] },
                });
                const received = yield* pull({
                  body: { maxMessages: 1, returnImmediately: false },
                }).pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("1 second"),
                    until: (page) => (page.receivedMessages ?? []).length > 0,
                    times: 10,
                  }),
                );
                const message = received.receivedMessages?.[0];
                yield* acknowledge({
                  body: { ackIds: [message?.ackId ?? ""] },
                });
                return { published, message };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect((out.published.messageIds ?? []).length).toBeGreaterThan(0);
      expect(out.message?.ackId).toEqual(expect.any(String));
      expect(out.message?.message?.data).toEqual(btoa("hello"));

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "GetSchema and ValidateMessage on an Avro schema",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const schema = yield* GCP.PubSub.Schema("Events", {
            type: "AVRO",
            definition: AVRO,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* schema.name;
              const getSchema = yield* GCP.PubSub.GetSchema(schema);
              const validate = yield* GCP.PubSub.ValidateMessage(schema);
              return Effect.fn(function* () {
                const live = yield* getSchema({ view: "FULL" });
                yield* validate({
                  encoding: "JSON",
                  message: btoa(JSON.stringify({ id: "abc" })),
                });
                return { live };
              });
            }),
          );
          return { schema, probe: yield* Probe({}) };
        }),
      );

      expect(out.probe.live.name).toEqual(out.schema.name);
      expect(out.probe.live.type).toEqual("AVRO");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
