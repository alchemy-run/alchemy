import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Vitest";
import * as googleTagGateway from "@distilled.cloud/cloudflare/google-tag-gateway";
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

// Freshly minted scoped tokens propagate eventually-consistently across
// Cloudflare's edge — ride out intermittent 403 blips on the test's own
// out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getConfig = (zoneId: string) =>
  googleTagGateway.getConfig({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// A known disabled baseline so each run starts from the same cloud state
// regardless of what a previous (possibly interrupted) run left behind.
const baseline = {
  enabled: false,
  endpoint: "/baseline",
  hideOriginalIp: false,
  measurementId: "G-BASELINE01",
  setUpTag: false,
} as const;

const setBaseline = (zoneId: string) =>
  googleTagGateway.putConfig({ zoneId, ...baseline }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

describe.sequential("GoogleTagGateway", () => {
  test.provider(
    "configures the gateway, updates in place, and restores the baseline on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* setBaseline(zoneId);

        yield* Effect.gen(function* () {
          // Create — enable the gateway with a deterministic config.
          const created = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.GoogleTagGateway("Gtg", {
                zone: { zoneId, name: zoneName },
                enabled: true,
                endpoint: "/metrics",
                measurementId: "G-TEST123456",
                hideOriginalIp: true,
                setUpTag: false,
              });
            }),
          );

          expect(created.zoneId).toEqual(zoneId);
          expect(created.enabled).toEqual(true);
          expect(created.endpoint).toEqual("/metrics");
          expect(created.measurementId).toEqual("G-TEST123456");
          expect(created.hideOriginalIp).toEqual(true);
          expect(created.setUpTag).toEqual(false);
          // The pre-management config was captured for restore-on-destroy.
          expect(created.initialConfig).toEqual(baseline);

          // Out-of-band verify the live config.
          const live = yield* getConfig(zoneId);
          expect(live).not.toBeNull();
          expect(live?.enabled).toEqual(true);
          expect(live?.endpoint).toEqual("/metrics");
          expect(live?.hideOriginalIp).toEqual(true);

          // Update in place — same zone, new endpoint and IP setting.
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.GoogleTagGateway("Gtg", {
                zone: { zoneId, name: zoneName },
                enabled: true,
                endpoint: "/collect2",
                measurementId: "G-TEST123456",
                hideOriginalIp: false,
                setUpTag: false,
              });
            }),
          );

          expect(updated.zoneId).toEqual(zoneId);
          expect(updated.endpoint).toEqual("/collect2");
          expect(updated.hideOriginalIp).toEqual(false);
          // Still the same singleton — the captured baseline is retained.
          expect(updated.initialConfig).toEqual(baseline);

          const liveUpdated = yield* getConfig(zoneId);
          expect(liveUpdated?.endpoint).toEqual("/collect2");
          expect(liveUpdated?.hideOriginalIp).toEqual(false);

          // Destroy — the gateway is restored to the pre-management baseline.
          yield* stack.destroy();

          const restored = yield* getConfig(zoneId);
          expect(restored).toEqual(baseline);
        }).pipe(
          // Leave the zone in the disabled baseline even if the test fails.
          Effect.ensuring(setBaseline(zoneId).pipe(Effect.ignore)),
        );
      }).pipe(logLevel),
    { timeout: 120_000 },
  );

  test.provider(
    "no-op redeploy skips the PUT and destroy is idempotent",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* setBaseline(zoneId);

        yield* Effect.gen(function* () {
          const program = Effect.gen(function* () {
            return yield* Cloudflare.GoogleTagGateway("GtgNoop", {
              zone: { zoneId, name: zoneName },
              enabled: false,
              endpoint: "/noop",
              measurementId: "GTM-TEST123",
              hideOriginalIp: false,
              setUpTag: false,
            });
          });

          const first = yield* stack.deploy(program);
          expect(first.endpoint).toEqual("/noop");
          expect(first.measurementId).toEqual("GTM-TEST123");
          expect(first.initialConfig).toEqual(baseline);

          // Redeploy with identical props — converges without drift.
          const second = yield* stack.deploy(program);
          expect(second.endpoint).toEqual("/noop");
          expect(second.initialConfig).toEqual(baseline);

          yield* stack.destroy();
          const restored = yield* getConfig(zoneId);
          expect(restored).toEqual(baseline);

          // Destroy again — idempotent.
          yield* stack.destroy();
          const stillRestored = yield* getConfig(zoneId);
          expect(stillRestored).toEqual(baseline);
        }).pipe(Effect.ensuring(setBaseline(zoneId).pipe(Effect.ignore)));
      }).pipe(logLevel),
    { timeout: 120_000 },
  );
});
