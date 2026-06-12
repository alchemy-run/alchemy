import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Freshly-minted scoped API tokens propagate eventually-consistently across
// Cloudflare's edge — ride out intermittent 403s on the test's own
// out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getLiveSetting = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* workers.getAccountSetting({ accountId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );
});

test.provider(
  "flips green compute, updates in place, and restores the baseline on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Observe the account's baseline out-of-band. The singleton always
      // exists, so the test works relative to whatever the account has.
      const baseline = yield* getLiveSetting;
      const baselineGreen = baseline.greenCompute ?? false;
      const flipped = !baselineGreen;

      // Create — pin green compute to the opposite of the baseline.
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.WorkersAccountSetting("AccountSetting", {
            greenCompute: flipped,
          });
        }),
      );

      expect(created.greenCompute).toEqual(flipped);
      // The pre-management value was captured for restore-on-destroy.
      expect(created.initialGreenCompute).toEqual(baseline.greenCompute);

      // Out-of-band verify the live account state.
      const live = yield* getLiveSetting;
      expect(live.greenCompute ?? false).toEqual(flipped);

      // Update in place — set it back to the baseline value. Same
      // singleton, no replacement; the captured initial value survives.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.WorkersAccountSetting("AccountSetting", {
            greenCompute: baselineGreen,
          });
        }),
      );

      expect(updated.greenCompute ?? false).toEqual(baselineGreen);
      expect(updated.initialGreenCompute).toEqual(baseline.greenCompute);

      const liveAfterUpdate = yield* getLiveSetting;
      expect(liveAfterUpdate.greenCompute ?? false).toEqual(baselineGreen);

      // Destroy — restores the pre-management values (already at the
      // baseline here, so this also exercises the idempotent no-op path).
      yield* stack.destroy();

      const restored = yield* getLiveSetting;
      expect(restored.greenCompute ?? false).toEqual(baselineGreen);
      expect(restored.defaultUsageModel).toEqual(baseline.defaultUsageModel);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "no-op deploy when desired settings already match the live account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const baseline = yield* getLiveSetting;

      // Deploy with the account's current values — reconcile observes no
      // drift and skips the PUT entirely.
      const setting = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.WorkersAccountSetting("NoopSetting", {
            defaultUsageModel: baseline.defaultUsageModel ?? undefined,
            greenCompute: baseline.greenCompute ?? undefined,
          });
        }),
      );

      expect(setting.defaultUsageModel).toEqual(
        baseline.defaultUsageModel ?? undefined,
      );
      expect(setting.greenCompute).toEqual(baseline.greenCompute ?? undefined);
      expect(setting.initialDefaultUsageModel).toEqual(
        baseline.defaultUsageModel ?? undefined,
      );
      expect(setting.initialGreenCompute).toEqual(
        baseline.greenCompute ?? undefined,
      );

      // Destroy — initial values match the live state, so restore is a
      // no-op and the account is left untouched.
      yield* stack.destroy();

      const after = yield* getLiveSetting;
      expect(after.defaultUsageModel).toEqual(baseline.defaultUsageModel);
      expect(after.greenCompute).toEqual(baseline.greenCompute);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
