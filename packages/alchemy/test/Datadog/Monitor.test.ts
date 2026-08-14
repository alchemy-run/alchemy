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

// Datadog credentials are resolved via the AuthProvider (env method reads
// DD_API_KEY / DD_APP_KEY, optionally DD_SITE). When they're absent the suite
// can't talk to the real API, so skipIf-gate the live tests. Without creds
// the failure mode would be an `AuthError`:
//   "Datadog env credentials not found. Set DD_API_KEY and DD_APP_KEY."
const hasDatadogCreds = !!(
  (process.env.DD_API_KEY || process.env.DATADOG_API_KEY) &&
  (process.env.DD_APP_KEY || process.env.DATADOG_APP_KEY)
);

// Deterministic names so re-runs reconcile the same resources rather than
// piling up duplicates. The query targets a built-in system metric so it
// evaluates in any org without requiring APM data to exist.
const MONITOR_NAME = "alchemy-test-monitor";

test.provider.skipIf(!hasDatadogCreds)(
  "monitor lifecycle: create, list, update, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Datadog.Monitor("TestMonitor", {
            name: MONITOR_NAME,
            type: "query alert",
            query: "avg(last_5m):avg:system.cpu.user{*} > 95",
            message: "CPU is high (alchemy lifecycle test)",
            tags: ["managed-by:alchemy", "env:test"],
            priority: 5,
            options: {
              thresholds: { critical: 95, warning: 80 },
              notify_no_data: false,
              require_full_window: false,
            },
          });
        }),
      );

      expect(deployed.id).toBeGreaterThan(0);
      expect(deployed.name).toEqual(MONITOR_NAME);
      // Datadog normalizes between the equivalent "query alert" /
      // "metric alert" pair, so accept either.
      expect(["query alert", "metric alert"]).toContain(deployed.type);
      expect(
        deployed.tags?.some((tag) => tag.startsWith("alchemy_stack:")),
      ).toBe(true);
      expect(
        deployed.tags?.some((tag) => tag.startsWith("alchemy_stage:")),
      ).toBe(true);
      expect(deployed.tags?.some((tag) => tag.startsWith("alchemy_id:"))).toBe(
        true,
      );

      // list() paginates the account's monitors and hydrates each row into
      // the exact `read` Attributes shape, limited to this stack's owned
      // Datadog resources.
      const provider = yield* Provider.findProvider(Datadog.Monitor);
      const all = yield* provider.list();
      const found = all.find((m) => m.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(MONITOR_NAME);

      // Update in place — same type, new message/threshold. The id must be
      // stable across the update.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Datadog.Monitor("TestMonitor", {
            name: MONITOR_NAME,
            type: "query alert",
            query: "avg(last_5m):avg:system.cpu.user{*} > 90",
            message: "CPU is high (updated by alchemy lifecycle test)",
            tags: ["managed-by:alchemy", "env:test"],
            priority: 4,
            options: {
              thresholds: { critical: 90, warning: 75 },
              notify_no_data: false,
              require_full_window: false,
            },
          });
        }),
      );

      expect(updated.id).toEqual(deployed.id);
      expect(updated.message).toEqual(
        "CPU is high (updated by alchemy lifecycle test)",
      );
      expect(updated.priority).toEqual(4);

      yield* stack.destroy();

      // Out-of-band: the monitor must actually be gone after destroy.
      const afterDestroy = yield* provider.list();
      expect(afterDestroy.find((m) => m.id === deployed.id)).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
