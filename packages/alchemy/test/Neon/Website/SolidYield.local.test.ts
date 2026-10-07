import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { providers } from "@/Neon/Providers.ts";
import { SolidYield } from "@/Neon/Website/SolidYield.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  cloneSolidYieldApp,
  solidYieldAppMarker,
  solidYieldPageMarker,
} from "../../Website/SolidYieldFixture.ts";

const { test } = Test.make({ providers: providers(), dev: true });

test.provider(
  "SolidYield dev serves the app through Vite with the yield transform",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const rootDir = yield* cloneSolidYieldApp("neon-solid-yield-dev-");
      const site = yield* stack.deploy(SolidYield("Web", { rootDir }));
      expect(String(site.url)).toMatch(/^http:\/\/localhost:\d+/);
      // Dev mode never creates a Neon Function.
      expect(site.function).toBeUndefined();
      const url = String(site.url).replace(/\/+$/, "");
      yield* expectUrlContains(`${url}/`, solidYieldPageMarker, {
        timeout: "120 seconds",
        label: "solid-yield dev index",
      });
      // Deep links fall back to index.html.
      yield* expectUrlContains(`${url}/todos/42`, solidYieldPageMarker, {
        timeout: "60 seconds",
        headers: { accept: "text/html" },
        label: "solid-yield dev spa fallback",
      });
      // vite-plugin-solid-yield rewrites `{yield* x}` JSX holes to `perform(x)`.
      const module = yield* expectUrlContains(`${url}/src/app.tsx`, solidYieldAppMarker, {
        timeout: "60 seconds",
        label: "solid-yield dev module",
      });
      expect(module).toContain("perform(");
      expect(module).not.toContain("{yield* count}");
      yield* stack.destroy();
    }),
  {
    tags: ["provider:neon", "provider:neon:website", "local"],
    timeout: 300_000,
  },
);
