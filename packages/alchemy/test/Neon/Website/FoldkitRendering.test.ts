import * as Neon from "@/Neon/index.ts";
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
import { getProject, getProjectBranchFunction } from "@distilled.cloud/neon";

const { test } = Test.make({ providers: Neon.providers() });

describe.sequential(
  "Neon Foldkit rendering modes",
  { tags: ["provider:neon", "provider:neon:website", "live"] },
  () => {
    for (const mode of foldkitModes) {
      for (const check of foldkitChecks) {
        test.provider.skipIf(
          !!process.env.FAST || (check === "browser" && !browserEnabled),
        )(
          `${mode}: ${check === "browser" ? "browser hydration" : "HTTP rendering"} and cleanup`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              const rootDir = yield* foldkitFixture(mode);

              const site = yield* stack.deploy(
                Neon.Website.Foldkit("Web", {
                  rootDir,
                  memo: foldkitMemo,
                }),
              );
              expect(site.url).toBeDefined();
              expect(site.function).toBeDefined();
              const fn = site.function!;
              const found = yield* getProjectBranchFunction({
                project_id: fn.projectId,
                branch_id: fn.branchId,
                slug: fn.slug,
              });
              expect(found.function.active_deployment?.id).toBe(
                fn.activeDeploymentId,
              );
              yield* verifyFoldkitRendering(site.url!, mode);
              if (check === "browser")
                yield* verifyFoldkitBrowser(site.url!, mode);
              yield* stack.destroy();
              const gone = yield* getProject({ project_id: fn.projectId })
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
