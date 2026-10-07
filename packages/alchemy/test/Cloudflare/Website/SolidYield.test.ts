import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import {
  cloneSolidYieldApp,
  expectSolidYieldBuild,
  solidYieldMemoInclude,
  solidYieldPageMarker,
} from "../../Website/SolidYieldFixture.ts";
import { expectDirectStatus, expectUrlContains } from "../Utils/Http.ts";
import { expectWorkerExists, waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const solidYieldProps = (rootDir: string) => ({
  rootDir,
  workersDev: true,
  compatibility: { date: "2024-09-23" },
  memo: { include: solidYieldMemoInclude },
});

describe.concurrent(
  "SolidYield",
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:website",
      "provider:cloudflare:worker",
      "live",
    ],
  },
  () => {
    test.provider(
      "SolidYield: builds the app and serves it with SPA fallback by default",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const rootDir = yield* cloneSolidYieldApp("alchemy-solid-yield-default-");

          const site = yield* stack.deploy(
            // Deliberately no `assets` — the SPA default is under test.
            Cloudflare.Website.SolidYield("FixSolidYieldDefault", solidYieldProps(rootDir)),
          );

          expect(site.url).toBeDefined();
          expect(site.hash?.input).toBeDefined();
          yield* expectWorkerExists(site.workerName, accountId);

          // index.html serves and its module script is the compiled app.
          yield* expectSolidYieldBuild(site.url!, {
            timeout: "120 seconds",
            label: "solid-yield index",
          });
          // Deep links fall back to index.html.
          yield* expectUrlContains(`${site.url!}/todos/42`, solidYieldPageMarker, {
            timeout: "60 seconds",
            label: "solid-yield spa fallback",
          });

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(site.workerName, accountId);
        }).pipe(logLevel),
      { timeout: 360_000 },
    );

    test.provider(
      "SolidYield: an explicit assets config overrides the SPA default",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;

          yield* stack.destroy();

          const rootDir = yield* cloneSolidYieldApp("alchemy-solid-yield-override-");

          const site = yield* stack.deploy(
            Cloudflare.Website.SolidYield("FixSolidYieldOverride", {
              ...solidYieldProps(rootDir),
              assets: { notFoundHandling: "none" },
            }),
          );

          yield* expectWorkerExists(site.workerName, accountId);
          yield* expectUrlContains(`${site.url!}/`, solidYieldPageMarker, {
            timeout: "120 seconds",
            label: "solid-yield override index",
          });
          yield* expectDirectStatus(`${site.url!}/todos/42`, 404, {
            timeout: "60 seconds",
            label: "solid-yield override deep link",
          });

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(site.workerName, accountId);
        }).pipe(logLevel),
      { timeout: 360_000 },
    );

    test.provider(
      "SolidYield: editing a component rebuilds and republishes the bundle",
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          yield* stack.destroy();

          const rootDir = yield* cloneSolidYieldApp("alchemy-solid-yield-edit-");

          const site1 = yield* stack.deploy(
            Cloudflare.Website.SolidYield("FixSolidYieldEdit", solidYieldProps(rootDir)),
          );
          yield* expectSolidYieldBuild(site1.url!, {
            timeout: "120 seconds",
            label: "solid-yield edit v1",
          });

          const appPath = path.join(rootDir, "src/app.tsx");
          const app = yield* fs.readFileString(appPath);
          yield* fs.writeFileString(
            appPath,
            app.replace("<h1>solid-yield-fixture</h1>", "<h1>solid-yield-v2-marker</h1>"),
          );

          const site2 = yield* stack.deploy(
            Cloudflare.Website.SolidYield("FixSolidYieldEdit", solidYieldProps(rootDir)),
          );
          expect(site2.hash?.input).not.toEqual(site1.hash?.input);

          const html = yield* expectUrlContains(`${site2.url!}/`, solidYieldPageMarker, {
            timeout: "60 seconds",
            label: "solid-yield edit v2 index",
          });
          const script = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
          expect(script).toBeDefined();
          yield* expectUrlContains(`${site2.url!}${script}`, "solid-yield-v2-marker", {
            timeout: "60 seconds",
            label: "solid-yield edit v2 bundle",
          });

          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
        }).pipe(logLevel),
      { timeout: 360_000 },
    );
  },
);
