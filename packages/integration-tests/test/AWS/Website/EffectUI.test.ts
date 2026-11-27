import * as AWS from "@alchemy.run/aws";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { effectUIFixture, effectUIMemo, verifyEffectUIRendering } from "../../Website/EffectUI.ts";

const { test } = Test.make({ providers: AWS.providers() });

// CloudFront Distribution create blocks on Status === "Deployed" (~5-15
// min) and destroy requires disable -> wait -> delete (another ~5-15 min).
// Skipped under --fast (FAST=1), like the other AWS.Website suites.
const runLive = !process.env.FAST;

// In dev the composite deploys only the framework dev server, so these
// live topology assertions are meaningless under the floci runner. Dev
// behavior is covered by EffectUI.local.test.ts.
const runEmulated = process.env.ALCHEMY_TEST_DEV === "1";

describe.skipIf(!runLive || runEmulated)(
  "AWS.Website.EffectUI",
  { tags: ["provider:aws", "provider:aws:website", "live"] },
  () => {
    // One distribution walked through every rendering mode. A browser-only
    // build is assets-only with the SPA fallback; prerendered pages are S3
    // objects and other routes reach the Web Function; `output: "static"`
    // then drops the server and serves only the pages.
    test.provider(
      "renders SPA, hybrid, SSR and static output, then cleans up",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const deploy = (
            mode: "spa" | "ssg" | "ssr" | "hybrid",
            props: { output?: "server" | "static"; errorPage?: string },
          ) =>
            Effect.gen(function* () {
              const rootDir = yield* effectUIFixture(mode);
              return yield* stack.deploy(
                AWS.Website.EffectUI("EffectUISite", {
                  rootDir,
                  ...props,
                  memo: effectUIMemo,
                  forceDestroy: true,
                  invalidation: { paths: "all", wait: true },
                }),
              );
            });

          const spa = yield* deploy("spa", {});
          expect(spa.server).toBeUndefined();
          yield* verifyEffectUIRendering(spa.url! as string, "spa");

          for (const mode of ["hybrid", "ssr"] as const) {
            const site = yield* deploy(mode, { output: "server" });
            expect(site.server).toBeDefined();
            yield* verifyEffectUIRendering(site.url! as string, mode, { runtime: /Node\.js/ });
          }

          const ssg = yield* deploy("ssg", { output: "static", errorPage: "404.html" });
          expect(ssg.server).toBeUndefined();
          yield* verifyEffectUIRendering(ssg.url! as string, "ssg");

          yield* stack.destroy();
        }),
      { timeout: 3_600_000 },
    );
  },
);
