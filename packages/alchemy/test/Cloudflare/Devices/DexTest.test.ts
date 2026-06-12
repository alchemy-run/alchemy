import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// DEX synthetic tests require the Digital Experience Monitoring
// entitlement. On the standard testing account
// `POST /accounts/{id}/dex/devices/dex_tests` fails with HTTP 403 code
// 11007 "dex.api.entitlements.missing" — surfaced as the typed
// `Forbidden` error. The lifecycle test is gated behind an entitled
// account supplied via env; the probe test always runs and pins the
// typed tag.
const entitled = !!process.env.CLOUDFLARE_TEST_DEX;

const TEST_NAME = "alchemy-test-dex";

test.provider.skipIf(entitled)(
  "unentitled accounts surface the typed Forbidden entitlement error",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const error = yield* zeroTrust
        .createDeviceDexTest({
          accountId,
          name: "alchemy-dex-entitlement-probe",
          enabled: true,
          interval: "0h30m0s",
          data: { host: "https://example.com", kind: "http", method: "GET" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("Forbidden");
      if (error._tag === "Forbidden") {
        expect(error.message).toContain("dex.api.entitlements.missing");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!entitled)(
  "create, update in place, and destroy a DEX test",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DeviceDexTest("AppHealth", {
            name: TEST_NAME,
            data: {
              host: "https://app.example.com/health",
              kind: "http",
              method: "GET",
            },
            interval: "0h30m0s",
            description: "v1",
          });
        }),
      );

      expect(created.testId).toBeDefined();
      expect(created.accountId).toEqual(accountId);
      expect(created.name).toEqual(TEST_NAME);
      expect(created.interval).toEqual("0h30m0s");
      expect(created.enabled).toEqual(true);

      const live = yield* zeroTrust.getDeviceDexTest({
        accountId,
        dexTestId: created.testId,
      });
      expect(live.name).toEqual(TEST_NAME);

      // Interval + description update converges in place — same test id.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.DeviceDexTest("AppHealth", {
            name: TEST_NAME,
            data: {
              host: "https://app.example.com/health",
              kind: "http",
              method: "GET",
            },
            interval: "1h0m0s",
            description: "v2",
            enabled: false,
          });
        }),
      );
      expect(updated.testId).toEqual(created.testId);
      expect(updated.interval).toEqual("1h0m0s");
      expect(updated.description).toEqual("v2");
      expect(updated.enabled).toEqual(false);

      yield* stack.destroy();

      const gone = yield* zeroTrust
        .getDeviceDexTest({ accountId, dexTestId: created.testId })
        .pipe(Effect.flip);
      expect(gone._tag).toEqual("DexTestNotFound");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
