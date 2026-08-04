import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Producer: logs on every request so each invocation produces a streaming
 * tail session (onset → log → outcome) for its streaming tail consumers.
 */
const producerScript = `export default {
  fetch() {
    console.log("alchemy-streaming-tail-marker");
    return new Response("streaming-producer-ok");
  },
};`;

/** The recorded shape of one streamed `TailEvent` in a consumer session. */
interface RecordedTailEvent {
  invocationId?: string;
  event?: { type?: string; outcome?: string; message?: unknown };
}

/**
 * `streamingTailConsumers` uploads `streaming_tail_consumers` in the script
 * metadata. Unlike plain `tail_consumers`, the script-settings read endpoint
 * does not expose the field, so the attachment is asserted through the
 * recorded attribute plus actual delivery: the consumer's `tailStream()`
 * persists each completed session into KV, observed out-of-band via
 * distilled KV reads.
 */
test.provider(
  "worker with streamingTailConsumers attaches the consumer and streams events",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployStack = (tails: "attached" | "detached") =>
        Effect.gen(function* () {
          const events = yield* Cloudflare.KV.Namespace("StreamTailEvents");
          const consumer = yield* Cloudflare.Worker("StreamingTailConsumer", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/tail/streaming-tail-consumer.ts",
            ),
            env: { EVENTS: events },
          });
          const producer = yield* Cloudflare.Worker("StreamingTailProducer", {
            script: producerScript,
            streamingTailConsumers: tails === "attached" ? [consumer] : [],
          });
          return { events, consumer, producer };
        });

      const v1 = yield* stack.deploy(deployStack("attached"));

      // The upload carried `streaming_tail_consumers` (the PUT would have
      // failed otherwise) and the attribute records the consumer by deployed
      // script name. GET script-settings has no field for streaming
      // consumers, so there is no out-of-band settings read to assert
      // against — delivery below is the cloud-side proof of attachment.
      expect(v1.producer.streamingTailConsumers).toEqual([
        { service: v1.consumer.workerName },
      ]);
      expect(v1.producer.tailConsumers ?? []).toEqual([]);

      // Invoke the producer (retrying through workers.dev propagation), then
      // poll KV until a completed streaming session lands. Each poll
      // re-invokes the producer so delivery that begins slightly after the
      // first request still surfaces.
      yield* expectUrlContains(v1.producer.url!, "streaming-producer-ok", {
        label: "streaming tail producer",
      });
      const eventKeys = yield* Effect.gen(function* () {
        yield* expectUrlContains(v1.producer.url!, "streaming-producer-ok", {
          timeout: "15 seconds",
          label: "streaming tail producer (poll)",
        });
        const keys = yield* kv.listNamespaceKeys({
          accountId,
          namespaceId: v1.events.namespaceId,
          prefix: "evt:",
        });
        return keys.result.map((k) => k.name);
      }).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (keys): boolean => keys.length > 0,
          times: 18,
        }),
      );
      expect(eventKeys.length).toBeGreaterThan(0);

      // The recorded session is a full onset → log → outcome stream from one
      // producer invocation, carrying the producer's log marker.
      const session = yield* kv
        .getNamespaceValue({
          accountId,
          namespaceId: v1.events.namespaceId,
          keyName: eventKeys[0],
        })
        .pipe(
          Effect.flatMap((res) =>
            Effect.tryPromise(() =>
              new Response(
                Stream.toReadableStream(res.body) as BodyInit,
              ).text(),
            ),
          ),
        );
      expect(session).toContain("alchemy-streaming-tail-marker");
      const events = JSON.parse(session) as RecordedTailEvent[];
      const types = events.map((tailEvent) => tailEvent.event?.type);
      expect(types).toContain("onset");
      expect(types).toContain("outcome");
      const log = events.find((tailEvent) => tailEvent.event?.type === "log");
      expect(log?.event?.message).toEqual(["alchemy-streaming-tail-marker"]);

      // Detaching every consumer is an in-place update, never a replace.
      const v2 = yield* stack.deploy(deployStack("detached"));
      expect(v2.producer.workerId).toEqual(v1.producer.workerId);
      expect(v2.producer.workerName).toEqual(v1.producer.workerName);
      expect(v2.producer.streamingTailConsumers ?? []).toEqual([]);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(v1.producer.workerName, accountId);
      yield* waitForWorkerToBeDeleted(v1.consumer.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
