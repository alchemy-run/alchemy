import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Railway from "@/Railway";
import * as Test from "@/Test/Alchemy";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  cloneSolidYieldApp,
  solidYieldAppMarker,
  solidYieldPageMarker,
} from "../../Website/SolidYieldFixture.ts";

const { test } = Test.make({ providers: Railway.providers(), dev: true });

describe(
  "Railway.Website.SolidYield local",
  { tags: ["provider:railway", "provider:railway:website", "local"] },
  () => {
    test.provider(
      "dev runs the framework server with no cloud resources",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneSolidYieldApp("alchemy-solid-yield-railway-local-");

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              const site = yield* Railway.Website.SolidYield("Web", {
                rootDir,
              });
              return { site };
            }),
          );

          const url = deployed.site.url;
          expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\/?$/);
          expect(deployed.site.service).toBeUndefined();
          expect(deployed.site.project).toBeUndefined();

          yield* expectUrlContains(`${url}/`, solidYieldPageMarker, {
            timeout: "90 seconds",
            label: "dev home page",
          });
          yield* expectUrlContains(`${url}/todos/42`, solidYieldPageMarker, {
            headers: { accept: "text/html" },
            label: "spa fallback",
          });
          // vite-plugin-solid-yield rewrites `{yield* x}` JSX holes to `perform(x)`.
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
