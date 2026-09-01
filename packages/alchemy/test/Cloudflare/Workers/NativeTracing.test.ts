import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import {
  CloudflareTelemetryCompatibilityError,
  MIN_CLOUDFLARE_TRACING_DATE,
} from "@/Cloudflare/Workers/Telemetry.ts";
import { resolveObservability } from "@/Cloudflare/Workers/WorkerAsyncBindings.ts";
import type { Worker } from "@/Cloudflare/Workers/Worker.ts";
import type { ResourceBinding } from "@/Resource.ts";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect, test as unit } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import NativeTracingWorker, {
  makeTracedWorker,
} from "./fixtures/native-tracing/worker.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Span rows Workers Observability has ingested for one script. Every row
 * carries Cloudflare's own `traceId` / `spanId` / `parentSpanId`, so the
 * tree the platform recorded can be checked directly.
 */
const querySpans = (accountId: string, service: string) =>
  // The timeframe is re-evaluated per poll: rows are keyed by ingestion
  // time, so a window fixed at the first attempt never sees late arrivals.
  Effect.suspend(() =>
    workers.queryObservabilityTelemetry({
      accountId,
      queryId: "adhoc-native-tracing-fanout",
      view: "events",
      timeframe: { from: Date.now() - 15 * 60 * 1000, to: Date.now() },
      limit: 500,
      parameters: {
        filters: [
          {
            key: "$metadata.service",
            operation: "eq",
            type: "string",
            value: service,
          },
          { key: "$metadata.spanName", operation: "exists", type: "string" },
        ],
      },
    }),
  ).pipe(
    Effect.map((response) =>
      (response.events?.events ?? []).map((event) => event.metadata),
    ),
  );

type Bindings = ReadonlyArray<ResourceBinding<Worker["Binding"]>>;

const tracesBind = (
  traces: NonNullable<Worker["Binding"]["observability"]>["traces"],
): Bindings =>
  [
    { sid: "Cloudflare.Telemetry", data: { observability: { traces } } },
  ] as unknown as Bindings;

describe("resolveObservability", () => {
  unit("omitted props + bound traces keep default logs", () => {
    const resolved = resolveObservability({}, tracesBind({ enabled: true }));
    expect(resolved.enabled).toBe(true);
    expect(resolved.logs?.enabled).toBe(true);
    expect(resolved.logs?.invocationLogs).toBe(true);
    expect(resolved.traces?.enabled).toBe(true);
  });

  unit("explicit traces.enabled false wins over the bind", () => {
    const resolved = resolveObservability(
      { observability: { enabled: true, traces: { enabled: false } } },
      tracesBind({ enabled: true, persist: true }),
    );
    expect(resolved.traces?.enabled).toBe(false);
    expect(resolved.traces?.persist).toBeUndefined();
  });

  unit("fills traces when news.observability exists without traces", () => {
    const resolved = resolveObservability(
      {
        observability: {
          enabled: true,
          logs: { enabled: true, invocationLogs: true, persist: true },
        },
      },
      tracesBind({ enabled: true, headSamplingRate: 1 }),
    );
    expect(resolved.logs?.persist).toBe(true);
    expect(resolved.traces?.enabled).toBe(true);
    expect(resolved.traces?.headSamplingRate).toBe(1);
  });

  unit("no bind returns default logs", () => {
    const resolved = resolveObservability({}, []);
    expect(resolved.traces).toBeUndefined();
    expect(resolved.logs?.invocationLogs).toBe(true);
  });
});

test.provider(
  "Cloudflare.Telemetry() enables traces without clobbering default logs",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* NativeTracingWorker;
        }),
      );

      const settings = yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: worker.workerName,
      });
      expect(settings.observability?.enabled).toBe(true);
      expect(settings.observability?.logs?.enabled).toBe(true);
      expect(settings.observability?.logs?.invocationLogs).toBe(true);
      expect(settings.observability?.traces?.enabled).toBe(true);

      yield* expectUrlContains(`${worker.url}/work`, "native-did-work", {
        timeout: "180 seconds",
      });

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "explicit observability.traces wins over Cloudflare.Telemetry() bind",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* makeTracedWorker("NativeTracingOverride", {
            observability: {
              enabled: true,
              traces: { enabled: false },
            },
          });
        }),
      );

      const settings = yield* workers.getScriptScriptAndVersionSetting({
        accountId,
        scriptName: worker.workerName,
      });
      expect(settings.observability?.traces?.enabled).toBe(false);
      expect(settings.observability?.logs?.invocationLogs).toBe(true);

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "Cloudflare.Telemetry() fails deploy on a pre-startActiveSpan compatibility date",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* makeTracedWorker("NativeTracingOldDate", {
              compatibility: { date: "2026-03-17" },
            });
          }),
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(CloudflareTelemetryCompatibilityError);
      expect(String(error)).toContain(MIN_CLOUDFLARE_TRACING_DATE);
      expect(String(error)).toContain("2026-03-17");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "Effect spans appear in Workers Observability after Cloudflare.Telemetry()",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* NativeTracingWorker;
        }),
      );

      yield* expectUrlContains(`${worker.url}/work`, "native-did-work", {
        timeout: "180 seconds",
      });

      // Poll until the request's Effect spans have been ingested.
      const spans = yield* querySpans(accountId, worker.workerName).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (spans) =>
            spans.some((s) => s.spanName === "operation") &&
            spans.some((s) => s.spanName === "native.child"),
          times: 36,
        }),
      );
      expect(spans.map((s) => s.spanName)).toEqual(
        expect.arrayContaining(["operation", "native.child"]),
      );

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

const EFFECT_SPANS = [
  "operation",
  "child.a",
  "child.a.inner",
  "child.b",
  "child.b.inner",
  "forked",
  "forked.inner",
];

test.provider(
  "concurrent fibers keep parent/sibling attribution in Workers Observability",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* NativeTracingWorker;
        }),
      );
      yield* expectUrlContains(
        `${worker.url}/fanout?id=warmup`,
        "native-did-fanout",
        { timeout: "180 seconds" },
      );

      // Several invocations in flight at once so fibers from different
      // requests interleave inside the isolate as well. Each request retries
      // through workers.dev propagation (a colo can still serve the
      // Cloudflare error page right after the warm-up succeeded elsewhere);
      // a retried id simply produces one more independent trace.
      const ids = yield* Effect.sync(() =>
        Array.from({ length: 3 }, () => globalThis.crypto.randomUUID()),
      );
      yield* Effect.all(
        ids.map((id) =>
          expectUrlContains(`${worker.url}/fanout?id=${id}`, id, {
            timeout: "120 seconds",
          }),
        ),
        { concurrency: "unbounded" },
      );

      // `request.id` is annotated on `operation`, so each request's trace
      // is located via `$metadata.requestId`; wait until every Effect span
      // of every request has been ingested.
      type Span =
        workers.ObservabilitySharedQueriesGetResponseEventsEventsItemMetadata;
      const operationOf = (spans: Span[], id: string) =>
        spans.find((s) => s.spanName === "operation" && s.requestId === id);
      const ingested = (spans: Span[]) =>
        ids.every((id) => {
          const operation = operationOf(spans, id);
          return (
            operation !== undefined &&
            EFFECT_SPANS.every((name) =>
              spans.some(
                (s) => s.traceId === operation.traceId && s.spanName === name,
              ),
            )
          );
        });
      const spans = yield* querySpans(accountId, worker.workerName).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: ingested,
          times: 36,
        }),
      );
      if (!ingested(spans)) {
        yield* Effect.logError(
          `native-tracing fan-out spans ingested so far: ${JSON.stringify(
            spans.map((s) => [s.requestId, s.spanName]),
          )}`,
        );
      }
      expect(ingested(spans)).toBe(true);

      for (const id of ids) {
        const operation = operationOf(spans, id)!;
        const trace = spans.filter((s) => s.traceId === operation.traceId);
        const span = (name: string) => {
          const matches = trace.filter((s) => s.spanName === name);
          expect(matches).toHaveLength(1);
          return matches[0]!;
        };
        // `operation` hangs off Cloudflare's own request span.
        expect(
          trace.some(
            (s) =>
              s.spanId === operation.parentSpanId && s.spanName !== "operation",
          ),
        ).toBe(true);
        for (const name of ["child.a", "child.b", "forked"]) {
          // Siblings: each branch is a direct child of `operation`, never
          // of another branch, even though the scheduler resumed it on a
          // timer tick outside `operation`'s async context.
          const branch = span(name);
          expect(branch.parentSpanId).toBe(operation.spanId);
          // Nesting inside the branch follows the Effect span tree.
          expect(span(`${name}.inner`).parentSpanId).toBe(branch.spanId);
          // The KV read is a Cloudflare auto-instrumented span; it must be
          // attributed to the branch whose fiber issued it.
          const platform = trace.filter(
            (s) =>
              s.parentSpanId === branch.spanId &&
              !EFFECT_SPANS.includes(s.spanName ?? ""),
          );
          expect(platform.length).toBeGreaterThanOrEqual(1);
        }
      }

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 300_000 },
);
