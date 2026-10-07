import * as machines from "@distilled.cloud/fly-io/machines";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  cloneSolidYieldApp,
  expectSolidYieldBuild,
  solidYieldMemoInclude,
  solidYieldPageMarker,
} from "../../Website/SolidYieldFixture.ts";

const { test } = Test.make({ providers: Fly.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (appName: string) =>
  machines.getApp({ app_name: appName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "SolidYield: deploy, GET /, destroy, gone",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const rootDir = yield* cloneSolidYieldApp("alchemy-solid-yield-fly-");

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const site = yield* Fly.Website.SolidYield("Web", {
            rootDir,
            memo: { include: solidYieldMemoInclude },
          });
          return { site };
        }),
      );

      const url = deployed.site.url;
      expect(url).toBeDefined();
      expect(url).toMatch(/^https:\/\//);
      expect(deployed.site.service).toBeDefined();
      expect(deployed.site.app).toBeDefined();

      // index.html serves and its module script is the compiled app.
      yield* expectSolidYieldBuild(url!, {
        timeout: "90 seconds",
        label: "home page",
      });
      yield* expectUrlContains(`${url!}/todos/42`, solidYieldPageMarker, {
        timeout: "30 seconds",
        label: "spa fallback",
      });

      const appName = deployed.site.app!.appName;
      yield* stack.destroy();
      const gone = yield* waitUntilGone(appName);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:fly", "provider:fly:machine", "provider:fly:website", "live"],
    timeout: 180000,
  },
);
