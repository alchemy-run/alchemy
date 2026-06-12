import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Vitest";
import * as apiGateway from "@distilled.cloud/cloudflare/api-gateway";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// The API Shield configuration (session identifiers) requires an API Shield
// entitlement (Enterprise). On the standard testing zone every call fails
// with the typed `NotEntitled` error (Cloudflare code 10403):
//   "You are not entitled for this service"
// The full lifecycle test is gated behind an entitled zone id from env.
const entitledZoneId = process.env.CLOUDFLARE_TEST_API_SHIELD_ZONE_ID;

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

// The scoped API token the test harness mints propagates eventually-
// consistently — a fresh token intermittently 403s. Ride out the blips on
// the test's own out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getConfiguration = (zoneId: string) =>
  apiGateway.getConfiguration({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

const setBaseline = (
  zoneId: string,
  authIdCharacteristics: { name: string; type: "header" | "cookie" }[],
) =>
  apiGateway.putConfiguration({ zoneId, authIdCharacteristics }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "surfaces the typed NotEntitled error on unentitled zones",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      // The standard testing zone lacks the API Shield entitlement — the
      // distilled call must fail with the typed entitlement tag.
      const error = yield* apiGateway.getConfiguration({ zoneId }).pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: forbiddenRetrySchedule,
          times: 8,
        }),
        Effect.flip,
      );
      expect(error._tag).toEqual("NotEntitled");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!entitledZoneId)(
  "sets session identifiers and restores the original value on destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = entitledZoneId!;

      yield* stack.destroy();
      // Known baseline: no session identifiers configured.
      yield* setBaseline(zoneId, []);

      const config = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShieldConfiguration("SessionIds", {
            zoneId,
            authIdCharacteristics: [{ name: "authorization", type: "header" }],
          });
        }),
      );

      expect(config.zoneId).toEqual(zoneId);
      expect(config.authIdCharacteristics).toEqual([
        { name: "authorization", type: "header" },
      ]);
      // The pre-management value was captured for restore-on-destroy.
      expect(config.initialAuthIdCharacteristics).toEqual([]);

      // Out-of-band verification via the distilled API.
      const live = yield* getConfiguration(zoneId);
      expect(live.authIdCharacteristics).toEqual([
        { name: "authorization", type: "header" },
      ]);

      // Update in place — same singleton, the captured baseline survives.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShieldConfiguration("SessionIds", {
            zoneId,
            authIdCharacteristics: [{ name: "session_id", type: "cookie" }],
          });
        }),
      );
      expect(updated.authIdCharacteristics).toEqual([
        { name: "session_id", type: "cookie" },
      ]);
      expect(updated.initialAuthIdCharacteristics).toEqual([]);

      // Destroy restores the captured baseline.
      yield* stack.destroy();

      const restored = yield* getConfiguration(zoneId);
      expect(restored.authIdCharacteristics).toEqual([]);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
