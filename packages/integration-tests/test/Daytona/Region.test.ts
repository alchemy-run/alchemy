import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organizations from "@distilled.cloud/daytona/organizations";
import * as runners from "@distilled.cloud/daytona/runners";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Daytona.providers() });

// Daytona Cloud has no custom regions; set DAYTONA_TEST_CUSTOM_REGIONS=1
// against a deployment that does (self-hosted, enterprise).
const customRegions = !!process.env.DAYTONA_TEST_CUSTOM_REGIONS;

test.provider.skipIf(customRegions)(
  "a deployment without custom regions fails with CustomRegionsUnavailable",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const error = yield* stack
        .deploy(Daytona.Region("Home", { proxyUrl: "https://proxy.example.com" }))
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomRegionsUnavailable");
      yield* stack.destroy();
    }),
  { tags: ["provider:daytona", "live"], timeout: 120_000 },
);

test.provider.skipIf(!customRegions)(
  "register a custom region and a runner, rotate a key, drain the runner, delete both",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (options: { rotate: number; draining: boolean }) =>
        stack.deploy(
          Effect.gen(function* () {
            const region = yield* Daytona.Region("Home", {
              proxyUrl: "https://proxy.example.com",
              rotate: { proxyApiKey: options.rotate },
            });
            const runner = yield* Daytona.Runner("Box", { region, draining: options.draining });
            return { region, runner };
          }),
        );
      const first = yield* deploy({ rotate: 0, draining: false });
      expect(first.region.proxyApiKey && Redacted.value(first.region.proxyApiKey)).toBeTruthy();
      expect(Redacted.value(first.runner.apiKey)).not.toEqual("");

      const second = yield* deploy({ rotate: 1, draining: true });
      expect(second.region.regionId).toEqual(first.region.regionId);
      expect(Redacted.value(second.region.proxyApiKey!)).not.toEqual(
        Redacted.value(first.region.proxyApiKey!),
      );
      expect((yield* runners.getRunner({ id: first.runner.runnerId })).draining).toBe(true);

      yield* stack.destroy();
      const regions = yield* organizations.listAvailableRegions({});
      expect(regions.some((r) => r.id === first.region.regionId)).toBe(false);
    }),
  { tags: ["provider:daytona", "live"], timeout: 180_000 },
);
