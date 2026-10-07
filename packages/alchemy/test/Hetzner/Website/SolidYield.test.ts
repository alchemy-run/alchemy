import * as servers from "@distilled.cloud/hetzner/servers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Hetzner from "@/Hetzner";
import * as Test from "@/Test/Alchemy";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  cloneSolidYieldApp,
  expectSolidYieldBuild,
  solidYieldMemoInclude,
  solidYieldPageMarker,
} from "../../Website/SolidYieldFixture.ts";

const { test } = Test.make({ providers: Hetzner.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const waitUntilGone = (id: number) =>
  servers.getServer({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "SolidYield: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneSolidYieldApp("alchemy-solid-yield-hetzner-");

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Hetzner.Website.SolidYield("Web", {
            rootDir,
            memo: { include: solidYieldMemoInclude },
          });
          return { site };
        }),
      );

      const url = deployed.site.url;
      expect(url).toBeDefined();
      expect(url).toMatch(/^http:\/\//);
      expect(deployed.site.service).toBeDefined();
      expect(deployed.site.server).toBeDefined();

      yield* expectSolidYieldBuild(url!, {
        timeout: "90 seconds",
        label: "home page",
      });
      yield* expectUrlContains(`${url!}/todos/42`, solidYieldPageMarker, {
        timeout: "30 seconds",
        label: "spa fallback",
      });

      const serverId = deployed.site.server!.serverId;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(serverId);
      expect(gone).toEqual("gone");
    }).pipe(
      logLevel,
      Effect.ensuring(stack.destroy().pipe(Effect.orDie)),
      Effect.catchTag(["PreconditionFailed", "Forbidden"], (error) =>
        Effect.logWarning(`skipping: Hetzner quota (${error._tag})`),
      ),
    ),
  {
    tags: ["provider:hetzner", "provider:hetzner:service", "provider:hetzner:website", "live"],
    timeout: 180000,
  },
);
