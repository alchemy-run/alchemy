import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as logs from "@distilled.cloud/cloudflare/logs";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The Customer Metadata Boundary is part of the Data Localization Suite and
// requires an Enterprise plan. On the standard testing account every
// `/logs/control/cmb/config` call fails with Cloudflare error code 10000
// ("Unauthorized"), surfaced as the typed `LogsControlNotAuthorized` error.
// The full lifecycle test below is gated behind an entitled account
// supplied via env.
const entitled = !!process.env.CLOUDFLARE_TEST_LOGS_CONTROL;

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips (`Forbidden`,
// declared in the distilled error union via patches) on out-of-band calls.
const getCmb = (accountId: string) =>
  logs.getControlCmbConfig({ accountId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

test.provider.skipIf(entitled)(
  "surfaces the typed LogsControlNotAuthorized error on unentitled accounts",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // The testing account has no CMB / Data Localization entitlement —
      // both reads and writes must fail with the typed authorization tag
      // (Cloudflare error code 10000).
      const readError = yield* logs
        .getControlCmbConfig({ accountId })
        .pipe(Effect.flip);
      expect(readError._tag).toEqual("LogsControlNotAuthorized");

      const writeError = yield* logs
        .createControlCmbConfig({ accountId, regions: "eu" })
        .pipe(Effect.flip);
      expect(writeError._tag).toEqual("LogsControlNotAuthorized");

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider.skipIf(!entitled)(
  "create, verify out-of-band, update in place, destroy, and wait until gone",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Create — pin the CMB region.
      const created = yield* stack.deploy(
        Cloudflare.LogsCmbConfig("Cmb", {
          regions: "eu",
        }),
      );
      expect(created.accountId).toEqual(accountId);
      expect(created.regions).toEqual("eu");

      const live = yield* getCmb(accountId);
      expect(live.regions).toEqual("eu");

      // Update in place — POST is a full upsert.
      const updated = yield* stack.deploy(
        Cloudflare.LogsCmbConfig("Cmb", {
          regions: "eu",
          allowOutOfRegionAccess: true,
        }),
      );
      expect(updated.regions).toEqual("eu");
      expect(updated.allowOutOfRegionAccess).toEqual(true);

      const liveUpdated = yield* getCmb(accountId);
      expect(liveUpdated.allowOutOfRegionAccess).toEqual(true);

      yield* stack.destroy();

      // Destroy removed the config — the account reads back unconfigured,
      // surfaced either as an empty result or the typed CmbConfigNotFound.
      const gone = yield* getCmb(accountId).pipe(
        Effect.map((config) => config.regions ?? undefined),
        Effect.catchTag("CmbConfigNotFound", () => Effect.succeed(undefined)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (regions) => regions === undefined,
          times: 10,
        }),
      );
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
