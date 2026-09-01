import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import {
  CloudflareTelemetryCompatibilityError,
  MIN_CLOUDFLARE_TRACING_DATE,
} from "@/Cloudflare/Workers/Telemetry.ts";
import {
  getObservabilityBinding,
  resolveObservability,
} from "@/Cloudflare/Workers/WorkerAsyncBindings.ts";
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

  unit("persist false last-defined-wins", () => {
    const bindings = [
      ...tracesBind({ enabled: true, persist: true }),
      ...tracesBind({ enabled: true, persist: false }),
    ] as unknown as Bindings;
    const bound = getObservabilityBinding(bindings);
    expect(bound?.persist).toBe(false);
    const resolved = resolveObservability({}, bindings);
    expect(resolved.traces?.persist).toBe(false);
  });

  unit("fills traces when news.observability exists without traces", () => {
    const resolved = resolveObservability(
      { observability: { enabled: true, logs: { persist: true } } },
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

      const since = Date.now() - 5 * 60 * 1000;
      const body = yield* workers
        .queryObservabilityTelemetry({
          accountId,
          queryId: "adhoc-native-tracing",
          view: "events",
          timeframe: { from: since, to: Date.now() },
          limit: 100,
          parameters: {
            filters: [
              {
                key: "$metadata.service",
                operation: "eq",
                type: "string",
                value: worker.workerName,
              },
            ],
          },
        })
        .pipe(
          Effect.catchTag("Unauthorized", () =>
            Effect.die(
              new Error(
                "Cloudflare rejected the observability telemetry query (Unauthorized). " +
                  'Mint credentials with the "workers_observability:read" scope.',
              ),
            ),
          ),
          Effect.catchTag("Forbidden", () =>
            Effect.die(
              new Error(
                "Cloudflare rejected the observability telemetry query (Forbidden). " +
                  'Mint credentials with the "workers_observability:read" scope.',
              ),
            ),
          ),
          Effect.map((response) => JSON.stringify(response)),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (text) =>
              text.includes("operation") || text.includes("native.child"),
            times: 10,
          }),
        );

      expect(body.includes("operation") || body.includes("native.child")).toBe(
        true,
      );

      yield* stack.destroy();
      yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);
