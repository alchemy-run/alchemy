import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Vitest";
import * as cache from "@distilled.cloud/cloudflare/cache";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { describe } from "vitest";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Cache Reserve is a usage-billed add-on. On the testing account's zone
// every GET/PATCH fails with "Sorry, this zone setting is not available for
// your plan type.", surfaced as the typed `SettingUnavailableForPlan` error.
// The full lifecycle test below is gated behind an entitled zone id
// supplied via env.
const entitledZoneId = process.env.CLOUDFLARE_TEST_CACHE_RESERVE_ZONE_ID;

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getCacheReserve = (zoneId: string) =>
  cache.getCacheReserve({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const setBaseline = (zoneId: string, value: "on" | "off") =>
  cache.patchCacheReserve({ zoneId, value }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Both cases mutate the same zone-level Cache Reserve singleton; run them serially so they don't corrupt each other's captured `initialValue` under the global concurrent test config.
describe.sequential("CacheReserve", () => {
  test.provider(
    "surfaces the typed SettingUnavailableForPlan error on unentitled zones",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();

        // The standard testing zone lacks the Cache Reserve subscription —
        // the distilled call must fail with the typed entitlement tag.
        const error = yield* cache.getCacheReserve({ zoneId }).pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.flip,
        );
        expect(error._tag).toEqual("SettingUnavailableForPlan");

        yield* stack.destroy();
      }).pipe(logLevel),
  );

  test.provider.skipIf(!entitledZoneId)(
    "enables Cache Reserve and restores the original value on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = entitledZoneId!;

        yield* stack.destroy();
        // Known baseline: Cache Reserve defaults to "off".
        yield* setBaseline(zoneId, "off");

        const setting = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.CacheReserve("Reserve", {
              zoneId,
            });
          }),
        );

        expect(setting.zoneId).toEqual(zoneId);
        expect(setting.value).toEqual("on");
        // The pre-management value was captured for restore-on-destroy.
        expect(setting.initialValue).toEqual("off");

        // Out-of-band verification via the distilled API.
        const live = yield* getCacheReserve(zoneId);
        expect(live.value).toEqual("on");

        // Update in place — same singleton, initialValue survives.
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.CacheReserve("Reserve", {
              zoneId,
              enabled: false,
            });
          }),
        );
        expect(updated.value).toEqual("off");
        expect(updated.initialValue).toEqual("off");

        yield* stack.destroy();

        // Destroy restored the value the setting had before we managed it.
        const restored = yield* getCacheReserve(zoneId);
        expect(restored.value).toEqual("off");
      }).pipe(logLevel),
  );
});
