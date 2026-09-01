import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { makeTracedWorker } from "./fixtures/native-tracing/worker.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import { startOtlpCollector } from "../Utils/OtlpCollector.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const collectorMain = pathe.resolve(
  import.meta.dirname,
  "fixtures/native-tracing/tail-collector.ts",
);

const producerFlags = {
  date: "2026-08-25",
  flags: ["streaming_tail_worker", "tail_worker_user_spans"],
};

interface RecordedTailEvent {
  invocationId?: string;
  spanContext?: { traceId?: string; spanId?: string };
  event?: {
    type?: string;
    name?: string;
    spanId?: string;
    outcome?: string;
    info?: unknown;
  };
}

const decodeAttributes = (
  info: unknown,
): Record<string, string | number | boolean> => {
  if (typeof info === "string") {
    try {
      return decodeAttributes(JSON.parse(info));
    } catch {
      return {};
    }
  }
  if (!Array.isArray(info)) return {};
  return Object.fromEntries(
    info.flatMap((item) => {
      if (
        item &&
        typeof item === "object" &&
        "name" in item &&
        "value" in item &&
        (typeof item.value === "string" ||
          typeof item.value === "number" ||
          typeof item.value === "boolean")
      ) {
        return [[String(item.name), item.value] as const];
      }
      return [];
    }),
  );
};

const pollSessions = (producerUrl: string, consumerUrl: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    yield* client.get(`${producerUrl}/work`).pipe(Effect.orDie);
    const res = yield* client.get(`${consumerUrl}/events`).pipe(Effect.orDie);
    const body = (yield* res.json.pipe(Effect.orDie)) as {
      sessions?: unknown;
    };
    return Array.isArray(body.sessions) ? (body.sessions as string[]) : [];
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (sessions): boolean =>
        sessions.some((session) => session.includes('"name":"operation"')),
      times: 20,
    }),
  );

test.provider(
  "local Cloudflare.Telemetry() nests Effect spans with platform children",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const events = yield* Cloudflare.KV.Namespace("NativeTracingEvents");
          const consumer = yield* Cloudflare.Worker("NativeTracingCollector", {
            main: collectorMain,
            env: { EVENTS: events },
          });
          const producer = yield* makeTracedWorker("NativeTracingProducer", {
            streamingTailConsumers: [consumer],
            compatibility: producerFlags,
          });
          return { events, consumer, producer };
        }),
      );

      expect(deployed.events.namespaceId).toMatch(/^dev:/);
      expect(deployed.producer.url).toMatch(/^http:\/\/localhost:\d+$/);
      yield* expectUrlContains(
        deployed.consumer.url!,
        "native-tracing-collector-ok",
      );

      const sessions = yield* pollSessions(
        deployed.producer.url!,
        deployed.consumer.url!,
      );
      const traces = sessions
        .map((session) => JSON.parse(session) as RecordedTailEvent[])
        .filter((trace) =>
          trace.some(
            (entry) =>
              entry.event?.type === "spanOpen" &&
              entry.event.name === "operation",
          ),
        );

      if (traces.length === 0) {
        yield* Effect.logError(
          `native-tracing tail sessions: ${JSON.stringify(sessions).slice(0, 4000)}`,
        );
      }
      expect(traces.length).toBeGreaterThanOrEqual(1);

      const trace = traces[0]!;
      const spanOpens = trace.filter(
        (entry) => entry.event?.type === "spanOpen",
      );
      const span = (name: string) => {
        const matches = spanOpens.filter((entry) => entry.event?.name === name);
        expect(matches.length).toBeGreaterThanOrEqual(1);
        return matches[0]!;
      };
      const operation = span("operation");
      expect(span("native.child").spanContext?.spanId).toBe(
        operation.event?.spanId,
      );
      const operationAttrs = Object.fromEntries(
        trace
          .filter(
            (entry) =>
              entry.event?.type === "attributes" &&
              entry.spanContext?.spanId === operation.event?.spanId,
          )
          .flatMap((entry) =>
            Object.entries(decodeAttributes(entry.event?.info)),
          ),
      );
      expect(operationAttrs["scalar.number"]).toBe(42);
      expect(operationAttrs["scalar.boolean"]).toBe(true);
      expect(operationAttrs).not.toHaveProperty("unsupported");
      expect(operationAttrs["effect.exit"]).toBe("success");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

const compositionTest = (order: "cf-last" | "otlp-last") =>
  test.provider(
    `local Cloudflare.Telemetry() + logs-only OTLP compose (${order})`,
    (stack) =>
      Effect.gen(function* () {
        const collector = yield* startOtlpCollector();
        const currentConfig = yield* ConfigProvider.ConfigProvider;
        yield* stack.destroy();

        const deployed = yield* stack
          .deploy(
            Effect.gen(function* () {
              return {
                producer: yield* makeTracedWorker(
                  order === "cf-last"
                    ? "NativeTracingComposeCfLast"
                    : "NativeTracingComposeOtlpLast",
                  { compatibility: { date: "2026-08-25" } },
                ),
              };
            }),
          )
          .pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.orElse(
                ConfigProvider.fromUnknown({
                  COLLECTOR_URL: collector.url,
                  COMPOSE_ORDER: order,
                }),
                currentConfig,
              ),
            ),
          );

        yield* expectUrlContains(deployed.producer.url!, "native-tracing-ok");
        yield* expectUrlContains(
          `${deployed.producer.url}/work`,
          "native-did-work",
        );

        yield* Effect.sync(() => collector.completedRequests.value).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("200 millis"),
            until: (posts) => posts >= 1,
            times: 40,
          }),
        );
        expect(collector.completedRequests.value).toBeGreaterThanOrEqual(1);

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 180_000 },
  );

compositionTest("cf-last");
compositionTest("otlp-last");
