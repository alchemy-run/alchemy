import { getProject, getService } from "@distilled.cloud/prisma/management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Prisma from "@/Prisma/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  cloneSolidYieldApp,
  expectSolidYieldBuild,
  solidYieldMemoInclude,
  solidYieldPageMarker,
} from "../../Website/SolidYieldFixture.ts";

const { test } = Test.make({ providers: Prisma.providers() });

test.provider(
  "SolidYield publishes the built SPA to Compute and cleans up",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const rootDir = yield* cloneSolidYieldApp("prisma-solid-yield-");
      const { site } = yield* stack.deploy(
        Prisma.Website.SolidYield("Web", {
          rootDir,
          memo: { include: solidYieldMemoInclude },
        }).pipe(Effect.map((site) => ({ site }))),
      );
      expect(site.url).toMatch(/^https:\/\//);
      const projectId = site.compute!.projectId;
      const appId = site.compute!.appId;
      yield* expectSolidYieldBuild(site.url!, { timeout: "90 seconds", label: "solid-yield" });
      yield* expectUrlContains(`${site.url}/todos/42`, solidYieldPageMarker, {
        timeout: "60 seconds",
        headers: { accept: "text/html" },
        label: "solid-yield spa fallback",
      });
      yield* stack.destroy();
      expect(
        yield* getService({ serviceId: appId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      expect(
        yield* getProject({ id: projectId }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
    }),
  {
    tags: ["provider:prisma", "provider:prisma:website", "live"],
    timeout: 240_000,
  },
);
