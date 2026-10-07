import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Prisma from "@/Prisma/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  cloneSolidYieldApp,
  solidYieldAppMarker,
  solidYieldPageMarker,
} from "../../Website/SolidYieldFixture.ts";

const { test } = Test.make({ providers: Prisma.providers(), dev: true });

test.provider(
  "SolidYield dev serves the yield-transformed app without cloud resources",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const rootDir = yield* cloneSolidYieldApp("prisma-solid-yield-dev-");
      const { site } = yield* stack.deploy(
        Prisma.Website.SolidYield("Web", { rootDir }).pipe(Effect.map((site) => ({ site }))),
      );
      expect(site.url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+/);
      expect(site.compute).toBeUndefined();
      expect(site.project).toBeUndefined();
      yield* expectUrlContains(`${site.url}/`, solidYieldPageMarker, {
        timeout: "120 seconds",
        label: "solid-yield dev index",
      });
      yield* expectUrlContains(`${site.url}/todos/42`, solidYieldPageMarker, {
        timeout: "60 seconds",
        headers: { accept: "text/html" },
        label: "solid-yield dev spa fallback",
      });
      // vite-plugin-solid-yield rewrites each JSX hole `{yield* x}` to `perform(x)`.
      const module = yield* expectUrlContains(`${site.url}/src/app.tsx`, solidYieldAppMarker, {
        timeout: "60 seconds",
        label: "solid-yield dev module",
      });
      expect(module).toContain("perform(");
      expect(module).not.toContain("{yield* count}");
      yield* stack.destroy();
    }),
  {
    tags: ["provider:prisma", "provider:prisma:website", "local"],
    timeout: 240_000,
  },
);
