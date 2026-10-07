import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import {
  cloneSolidYieldApp,
  solidYieldAppMarker,
  solidYieldMemoInclude,
  solidYieldPageMarker,
} from "../../Website/SolidYieldFixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

describe(
  "SolidYield dev",
  { tags: ["provider:cloudflare", "provider:cloudflare:website", "local"] },
  () => {
    test.provider(
      "SolidYield dev: serves the app through Vite with the yield transform and picks up edits",
      (stack) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          yield* stack.destroy();

          const rootDir = yield* cloneSolidYieldApp("alchemy-solid-yield-dev-");

          const site = yield* stack.deploy(
            Cloudflare.Website.SolidYield("SolidYieldLocal", {
              rootDir,
              dev: { port: 0 },
              memo: { include: solidYieldMemoInclude },
            }),
          );

          expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
          yield* expectUrlContains(`${site.url!}/`, solidYieldPageMarker, {
            timeout: "180 seconds",
            label: "solid-yield dev index",
          });
          // Deep links fall back to index.html in dev too.
          yield* expectUrlContains(`${site.url!}/todos/42`, solidYieldPageMarker, {
            timeout: "60 seconds",
            headers: { accept: "text/html" },
            label: "solid-yield dev spa fallback",
          });
          // The component module is served through the app's own plugins:
          // vite-plugin-solid-yield rewrites each JSX hole `{yield* x}` to
          // `perform(x)` before Solid's compiler emits DOM templates.
          const module = yield* expectUrlContains(`${site.url!}/src/app.tsx`, solidYieldAppMarker, {
            timeout: "60 seconds",
            label: "solid-yield dev module",
          });
          expect(module).toContain("perform(");
          expect(module).not.toContain("{yield* count}");

          const appPath = path.join(rootDir, "src/app.tsx");
          const app = yield* fs.readFileString(appPath);
          yield* fs.writeFileString(
            appPath,
            app.replace("<h1>solid-yield-fixture</h1>", "<h1>solid-yield-hmr-marker</h1>"),
          );
          yield* expectUrlContains(`${site.url!}/src/app.tsx`, "solid-yield-hmr-marker", {
            timeout: "60 seconds",
            label: "solid-yield dev module after edit",
          });

          yield* stack.destroy();
        }).pipe(logLevel),
      { timeout: 300_000 },
    );
  },
);
