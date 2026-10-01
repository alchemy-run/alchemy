import * as Prisma from "@/Prisma/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  browserEnabled,
  foldkitChecks,
  foldkitFixture,
  foldkitMemo,
  foldkitModes,
  verifyFoldkitBrowser,
  verifyFoldkitRendering,
} from "../../Website/FoldkitRendering.ts";
import { getProject, getService } from "@distilled.cloud/prisma/management";

const { test } = Test.make({ providers: Prisma.providers() });

describe.sequential(
  "Prisma Foldkit rendering modes",
  { tags: ["provider:prisma", "provider:prisma:website", "live"] },
  () => {
    for (const mode of foldkitModes) {
      for (const check of foldkitChecks) {
        test.provider.skipIf(
          !!process.env.FAST ||
            (check === "browser" && !browserEnabled) ||
            process.env.ALCHEMY_RUN_LIVE_PRISMA_TESTS !== "true",
        )(
          `${mode}: ${check === "browser" ? "browser hydration" : "HTTP rendering"} and cleanup`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const rootDir = yield* foldkitFixture(mode);

              const site = yield* stack.deploy(
                Prisma.Website.Foldkit("Web", {
                  rootDir,
                  memo: foldkitMemo,
                }),
              );
              expect(site.url).toBeDefined();
              expect(site.compute).toBeDefined();
              const compute = site.compute!;
              yield* getService({ serviceId: compute.appId });
              yield* verifyFoldkitRendering(site.url!, mode);
              if (check === "browser")
                yield* verifyFoldkitBrowser(site.url!, mode);
              yield* stack.destroy();
              const gone = yield* getService({ serviceId: compute.appId })
                .pipe(
                  Effect.as(false),
                  Effect.catchTag("NotFound", () => Effect.succeed(true)),
                )
                .pipe(
                  Effect.repeat({
                    schedule: Schedule.spaced("1 second"),
                    times: 8,
                    until: (gone) => gone,
                  }),
                );
              expect(gone).toBe(true);
              expect(
                yield* getProject({ id: compute.projectId }).pipe(
                  Effect.as(false),
                  Effect.catchTag("NotFound", () => Effect.succeed(true)),
                ),
              ).toBe(true);
            }),
          {
            tags: [check === "browser" ? "browser" : "http"],
            timeout: 120_000,
          },
        );
      }
    }
  },
);
