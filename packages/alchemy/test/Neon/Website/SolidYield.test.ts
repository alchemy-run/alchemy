import { getProject } from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { providers } from "@/Neon/Providers.ts";
import { SolidYield } from "@/Neon/Website/SolidYield.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  cloneSolidYieldApp,
  expectSolidYieldBuild,
  solidYieldPageMarker,
} from "../../Website/SolidYieldFixture.ts";
import { functionRolloutTimeout } from "../FunctionRollout.ts";

const { test } = Test.make({ providers: providers() });

// Deploys, polls Function rollout, and verifies over HTTP; skip under --fast.
test.provider.skipIf(!!process.env.FAST)(
  "SolidYield builds the app and serves it with SPA fallback",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const rootDir = yield* cloneSolidYieldApp("neon-solid-yield-");
      const site = yield* stack.deploy(SolidYield("Web", { rootDir }));
      expect(site.url).toMatch(/^https:\/\//);
      const url = String(site.url).replace(/\/+$/, "");
      const fn = site.function!;
      yield* expectSolidYieldBuild(url, {
        timeout: "120 seconds",
        label: "solid-yield index",
      });
      yield* expectUrlContains(`${url}/todos/42`, solidYieldPageMarker, {
        timeout: "60 seconds",
        label: "solid-yield spa fallback",
      });
      yield* stack.destroy();
      expect(
        yield* getProject({ project_id: fn.projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  {
    tags: ["provider:neon", "provider:neon:website", "live"],
    timeout: functionRolloutTimeout,
  },
);
