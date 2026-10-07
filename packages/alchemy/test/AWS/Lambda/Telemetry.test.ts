import { describe, expect } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as pathe from "pathe";
import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import type { OtelSink } from "./fixtures/otel-collector-worker.ts";
import { OtelTestFunction, OtelTestFunctionLive } from "./fixtures/otel-handler.ts";

const { test } = Test.make({ providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()) });

const collectorMain = pathe.resolve(import.meta.dirname, "fixtures/otel-collector-worker.ts");

// The OTLP sink the Lambda exports to. A workers.dev URL is fine here —
// the 1042 worker-to-worker restriction doesn't apply to requests coming
// from Lambda. Declared identically in both deploy steps so the second
// deploy keeps it.
const collectorWorker = () =>
  Cloudflare.Worker("OtelCollector", {
    main: collectorMain,
    env: { SINK: Cloudflare.DurableObject<OtelSink>("OtelSink") },
    compatibility: { date: "2024-09-23" },
  });

interface CollectedSpan {
  name: string;
  status?: { code?: number };
  attributes?: { key: string; value: Record<string, unknown> }[];
}

// The `http.server` spans for one path, across every OTLP traces push the
// collector recorded.
const rootSpansFor = (collected: unknown, path: string): CollectedSpan[] =>
  (collected as { items: { signal: string; payload: any }[] }).items
    .filter((item) => item.signal === "traces")
    .flatMap((item) => item.payload.resourceSpans ?? [])
    .flatMap((resource: any) => resource.scopeSpans ?? [])
    .flatMap((scope: any) => (scope.spans ?? []) as CollectedSpan[])
    .filter(
      (span) =>
        span.name.startsWith("http.server") &&
        span.attributes?.some(
          (attribute) => attribute.key === "url.path" && attribute.value.stringValue === path,
        ),
    );

describe(
  "AWS.Lambda Telemetry",
  {
    tags: [
      "provider:aws",
      "provider:aws:lambda",
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "live",
    ],
  },
  () => {
    test.provider(
      "Lambda exports OTLP telemetry per invocation",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          // Deploy the collector first: the Lambda's OTLP endpoint is
          // resolved from the deployer's environment at deploy time.
          const collector = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* collectorWorker();
            }),
          );
          const collected = `${collector.url}/collected`;
          yield* expectUrlContains(collected, "otel-collector-ok", { timeout: "180 seconds" });

          // The fixture's telemetry binding layer reads `COLLECTOR_URL` via
          // `Config` at Init. The test harness snapshots its ConfigProvider
          // before the test body runs, so layer the just-learned collector
          // URL on top of the current provider for this deploy only.
          const currentConfig = yield* ConfigProvider.ConfigProvider;
          const { fn } = yield* stack
            .deploy(
              Effect.gen(function* () {
                yield* collectorWorker();
                const fn = yield* OtelTestFunction.pipe(Effect.provide(OtelTestFunctionLive));
                return { fn };
              }),
            )
            .pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.orElse(
                  ConfigProvider.fromUnknown({ COLLECTOR_URL: collector.url }),
                  currentConfig,
                ),
              ),
            );

          // Wait for the function URL to serve AND for the collector to be
          // reachable from the Lambda's region — workers.dev propagates
          // per-PoP, so the Lambda can see placeholder 404s long after the
          // test machine gets 200s.
          const fnUrl = (fn.functionUrl as string).replace(/\/$/, "");
          yield* expectUrlContains(`${fnUrl}/probe`, '"status":200', {
            timeout: "240 seconds",
            label: "collector reachable from Lambda",
          });

          // Drive one traced invocation.
          yield* expectUrlContains(`${fnUrl}/work`, "lambda-did-work", { timeout: "120 seconds" });

          // The invocation scope's flush ships everything the invocation
          // produced before the response is returned.
          yield* expectUrlContains(collected, "otel-lambda-test", {
            timeout: "120 seconds",
            label: "lambda service.name",
          });
          // http.server root span from the HttpMiddleware tracer.
          yield* expectUrlContains(collected, "http.server GET");
          // Child span from Effect.fn instrumentation.
          yield* expectUrlContains(collected, "lambda.child-span");
          // Log record shipped by the OTLP logger.
          yield* expectUrlContains(collected, "lambda-work-log");

          // A timing-out invocation: the fixture's timeout is 5 s and `/slow`
          // sleeps 60 s, so Lambda kills it and the Function URL answers with
          // an error. 2 s before that the deadline flush ended the root
          // span with the timeout and drained the exporters, so the trace
          // exists. Without it Lambda kills the invocation and nothing below
          // ever reaches the collector.
          const client = yield* HttpClient.HttpClient;
          const slow = yield* client.get(`${fnUrl}/slow`);
          expect(slow.status).not.toBe(200);
          yield* expectUrlContains(collected, "AWS.Lambda.InvocationTimeoutError", {
            timeout: "120 seconds",
            label: "timed-out invocation's root span",
          });
          yield* expectUrlContains(collected, "aws.lambda.timeout.imminent");
          // The child span that ended before the sleep and its log travel in
          // the same flush.
          yield* expectUrlContains(collected, "lambda.slow-span");
          yield* expectUrlContains(collected, "lambda-slow-log");

          // An invocation that finishes after the deadline flush but before
          // the timeout: the response is untouched, and its root span is
          // exported exactly once — by the flush, as timeout-imminent. The
          // dispatcher flushes again before responding, so any second
          // export has reached the collector by the time we see the 200.
          const late = yield* client.get(`${fnUrl}/late`);
          expect(late.status).toBe(200);
          expect(yield* late.text).toContain("lambda-late-done");
          const lateSpans = yield* client.get(collected).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((body) => rootSpansFor(body, "/late")),
          );
          expect(lateSpans).toHaveLength(1);
          expect(lateSpans[0]?.status?.code).toBe(2);
          expect(lateSpans[0]?.attributes).toContainEqual({
            key: "aws.lambda.timeout.imminent",
            value: { boolValue: true },
          });
        }),
      { timeout: 600_000 },
    );
  },
);
