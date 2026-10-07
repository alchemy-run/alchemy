import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  cloneSolidYieldApp,
  solidYieldAppMarker,
  solidYieldPageMarker,
} from "../../Website/SolidYieldFixture.ts";

const { test } = Test.make({ providers: Fly.providers(), dev: true });

describe(
  "Fly.Website.SolidYield local",
  { tags: ["provider:fly", "provider:fly:website", "local"] },
  () => {
    test.provider(
      "dev runs the framework server with no cloud resources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneSolidYieldApp("alchemy-solid-yield-fly-local-");

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const site = yield* Fly.Website.SolidYield("Web", {
                rootDir,
              });
              return { site };
            }),
          );

          const url = deployed.site.url;
          expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
          expect(deployed.site.service).toBeUndefined();
          expect(deployed.site.app).toBeUndefined();
          expect(deployed.site.ip).toBeUndefined();

          yield* expectUrlContains(`${url}/`, solidYieldPageMarker, {
            timeout: "90 seconds",
            label: "dev home page",
          });
          yield* expectUrlContains(`${url}/todos/42`, solidYieldPageMarker, {
            headers: { accept: "text/html" },
            label: "spa fallback",
          });
          // vite-plugin-solid-yield rewrites each JSX hole `{yield* x}` to
          // `perform(x)` before Solid's compiler runs.
          const module = yield* expectUrlContains(`${url}/src/app.tsx`, solidYieldAppMarker, {
            timeout: "60 seconds",
            label: "dev module",
          });
          expect(module).toContain("perform(");
          expect(module).not.toContain("{yield* count}");

          yield* stack.destroy();
        }),
      { timeout: 120_000 },
    );
  },
);
