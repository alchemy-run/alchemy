import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as mnm from "@distilled.cloud/cloudflare/magic-network-monitoring";
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

// The scoped API token the harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's own
// out-of-band calls.
const forbiddenRetry = {
  while: (e: { _tag: string }) => e._tag === "Forbidden",
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

describe.sequential("MagicNetworkMonitoring.Config list", () => {
  test.provider("list enumerates the account MNM config", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();
      // The config is an account singleton with no ownership markers — a
      // leftover from an interrupted run would surface as `Unowned` and
      // block this stack's create, so normalize to "absent" first.
      yield* mnm.deleteConfig({ accountId }).pipe(
        Effect.catchTag("MnmConfigNotFound", () => Effect.void),
        Effect.retry(forbiddenRetry),
      );

      const deployed = yield* stack.deploy(
        Cloudflare.MagicNetworkMonitoringConfig("Config", {
          name: "alchemy-mnm-list-test",
          defaultSampling: 1,
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.MagicNetworkMonitoringConfig,
      );
      const all = yield* provider.list();

      // Account singleton: when present, exactly one element with the full
      // Attributes shape (the same object `read` returns).
      expect(all.length).toEqual(1);
      const config = all[0];
      expect(config.accountId).toEqual(accountId);
      expect(config.name).toEqual(deployed.name);
      expect(config.defaultSampling).toEqual(deployed.defaultSampling);
      expect(config.routerIps).toEqual([]);
      expect(config.warpDevices).toEqual([]);

      yield* stack.destroy();

      // With the singleton unset, `list` returns the empty array, not a throw.
      const afterDestroy = yield* provider.list();
      expect(afterDestroy).toEqual([]);
    }).pipe(logLevel),
  );
});
