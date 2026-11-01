import * as Docker from "@alchemy.run/docker";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as intake from "@distilled.cloud/stackit/intake";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { ensureDockerSwarm } from "../../Docker/Runtime.ts";
import { stackitTags } from "../helpers.ts";
import IntakeKafkaHost, { Events, KAFKA_HOST_EXTERNAL_PORT } from "./fixtures/kafka-host.ts";
import { slow } from "./intake.ts";

const providers = Layer.mergeAll(Stackit.providers(), Docker.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitIntakeKafkaStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    yield* IntakeKafkaHost;
    const pipeline = yield* Events;
    return {
      projectId: pipeline.projectId,
      region: pipeline.region,
      intakeId: pipeline.intakeId,
      topic: pipeline.topic,
    };
  }),
);

const HOST_URL = `http://127.0.0.1:${KAFKA_HOST_EXTERNAL_PORT}`;

const options = { timeout: 600_000 } as const;

const getJson = (route: string) =>
  HttpClient.get(`${HOST_URL}${route}`).pipe(
    Effect.timeout("60 seconds"),
    Effect.flatMap((response) => response.json),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
  );

// A runner is billed per started hour: gated behind STACKIT_TEST_SLOW (see intake.ts). The
// host runs on the local Docker swarm.
describe.sequential.skipIf(slow)(
  "STACKIT Intake Kafka bindings on a Docker service",
  { tags: [...stackitTags("intake", "kafka"), "provider:docker"] },
  () => {
    const stack = beforeAll(ensureDockerSwarm.pipe(Effect.orDie, Effect.andThen(deploy(Stack))), {
      timeout: 2_700_000,
    });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 2_700_000 });

    describe("Produce", () => {
      test(
        "publishes to the intake's topic",
        Effect.gen(function* () {
          const { topic } = yield* stack;
          const body = (yield* getJson(
            `/produce?value=${encodeURIComponent(JSON.stringify({ hello: "world" }))}`,
          )) as { ok: boolean; records?: Array<{ topic: string }>; error?: string };
          expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });
          expect(body.records?.[0]?.topic).toEqual(topic);
        }),
        options,
      );
    });

    describe("ConsumeDeadLetter", () => {
      test.provider(
        "takes a message the intake couldn't deliver",
        (_stack) =>
          Effect.gen(function* () {
            const { projectId, region, intakeId } = yield* stack;
            // Not JSON, so the intake sends it to the dead letter topic.
            const sent = "not json";
            const published = (yield* getJson(`/produce?value=${encodeURIComponent(sent)}`)) as {
              ok: boolean;
              error?: string;
            };
            expect({ ok: published.ok, error: published.error }).toEqual({ ok: true });

            // Out of band: the intake counts it, about five minutes after it arrives.
            const live = yield* intake.getIntake({ projectId, regionId: region, intakeId }).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("15 seconds"),
                until: (observed) => (observed.undeliveredMessageCount ?? 0) > 0,
                times: 28,
              }),
            );
            expect(live.undeliveredMessageCount).toBeGreaterThan(0);

            const body = (yield* getJson("/dead-letters")) as {
              taken: Array<{ text: string }>;
              error?: string;
            };
            expect(body.error).toBeUndefined();
            expect(body.taken.map((message) => message.text)).toContain(sent);
          }),
        options,
      );

      test(
        "`skip` moves past a message whose handler dies",
        Effect.gen(function* () {
          // The message the case above sent is still there for this group.
          const first = (yield* getJson("/dead-letters-skip")) as {
            taken: string[];
            error?: string;
          };
          expect(first.error).toBeUndefined();
          expect(first.taken).toContain("not json");

          // The group moved past it, so a defect didn't hold the partition.
          const second = (yield* getJson("/dead-letters-skip")) as {
            taken: string[];
            error?: string;
          };
          expect(second.error).toBeUndefined();
          expect(second.taken).not.toContain("not json");
        }),
        options,
      );
    });
  },
);
