import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { describe } from "vitest";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

describe.sequential("MagicNetworkMonitoring.Config list", () => {
  test.provider("list enumerates the account MNM config", (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        // The config is an account singleton with no ownership markers, so a
        // leftover from an interrupted run surfaces as `Unowned`. Adopt it
        // rather than failing with `OwnedBySomeoneElse` or racing an
        // out-of-band delete against the singleton's eventual consistency.
        Cloudflare.MagicNetworkMonitoringConfig("Config", {
          name: "alchemy-mnm-list-test",
          defaultSampling: 1,
        }).pipe(adopt(true)),
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
