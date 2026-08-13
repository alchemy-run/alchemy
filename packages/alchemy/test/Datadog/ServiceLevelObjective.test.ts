import * as Datadog from "@/Datadog";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Datadog.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasDatadogCreds = !!(
  (process.env.DD_API_KEY || process.env.DATADOG_API_KEY) &&
  (process.env.DD_APP_KEY || process.env.DATADOG_APP_KEY)
);

// Deterministic names so re-runs reconcile the same resources. Metric SLO
// queries use a built-in system metric so they validate in any org.
const METRIC_SLO_NAME = "alchemy-test-metric-slo";
const MONITOR_SLO_NAME = "alchemy-test-monitor-slo";
const MONITOR_NAME = "alchemy-test-slo-monitor";

test.provider.skipIf(!hasDatadogCreds)(
  "metric SLO lifecycle: create, read, update thresholds, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Datadog.ServiceLevelObjective("TestMetricSlo", {
            name: METRIC_SLO_NAME,
            type: "metric",
            description: "alchemy SLO lifecycle test",
            query: {
              numerator: "sum:system.cpu.user{*}.as_count()",
              denominator: "sum:system.cpu.user{*}.as_count()",
            },
            thresholds: [{ timeframe: "30d", target: 99 }],
            timeframe: "30d",
            target_threshold: 99,
            tags: ["managed-by:alchemy", "env:test"],
          });
        }),
      );

      expect(deployed.id).toBeTruthy();
      expect(deployed.name).toEqual(METRIC_SLO_NAME);
      expect(deployed.type).toEqual("metric");

      // Update in place — tighten the target. The id must be stable.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Datadog.ServiceLevelObjective("TestMetricSlo", {
            name: METRIC_SLO_NAME,
            type: "metric",
            description: "alchemy SLO lifecycle test (updated)",
            query: {
              numerator: "sum:system.cpu.user{*}.as_count()",
              denominator: "sum:system.cpu.user{*}.as_count()",
            },
            thresholds: [{ timeframe: "30d", target: 99.5 }],
            timeframe: "30d",
            target_threshold: 99.5,
            tags: ["managed-by:alchemy", "env:test"],
          });
        }),
      );

      expect(updated.id).toEqual(deployed.id);
      expect(updated.target_threshold).toEqual(99.5);

      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Datadog.ServiceLevelObjective,
      );
      const afterDestroy = yield* provider.list();
      expect(afterDestroy.find((s) => s.id === deployed.id)).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasDatadogCreds)(
  "monitor SLO tracks the uptime of a deployed monitor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const monitor = yield* Datadog.Monitor("SloMonitor", {
            name: MONITOR_NAME,
            type: "query alert",
            query: "avg(last_5m):avg:system.cpu.user{*} > 95",
            message: "alchemy monitor-SLO test",
            tags: ["managed-by:alchemy", "env:test"],
          });
          // Reference the monitor's OUTPUT id so the SLO create waits for
          // the monitor create — Datadog rejects an SLO over a missing
          // monitor id.
          const slo = yield* Datadog.ServiceLevelObjective("TestMonitorSlo", {
            name: MONITOR_SLO_NAME,
            type: "monitor",
            monitor_ids: [monitor.id],
            thresholds: [{ timeframe: "30d", target: 99.9 }],
            timeframe: "30d",
            target_threshold: 99.9,
            tags: ["managed-by:alchemy", "env:test"],
          });
          return { monitor, slo };
        }),
      );

      expect(deployed.slo.type).toEqual("monitor");
      expect(deployed.slo.monitor_ids).toEqual([deployed.monitor.id]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
