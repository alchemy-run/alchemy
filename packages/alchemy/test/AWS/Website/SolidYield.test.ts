import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import {
  cloneSolidYieldApp,
  expectSolidYieldBuild,
  solidYieldPageMarker,
} from "../../Website/SolidYieldFixture.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Gated: CloudFront Distribution create blocks on Status === "Deployed"
// (~5-15 min) and destroy requires disable -> wait -> delete (another
// ~5-15 min). Skipped under --fast (FAST=1) (same gate
// as the AWS.CloudFront and AWS.Website.Vite suites).
const runLive = !process.env.FAST;

// Skipped under the floci runner: in dev the composite deploys only the
// framework dev server (no Lambda/S3/CloudFront), so this test's live
// topology assertions are meaningless there. Dev behavior is covered by
// the co-located SolidYield.local.test.ts suite.
const runEmulated = process.env.ALCHEMY_TEST_DEV === "1";

describe.skipIf(!runLive || runEmulated)(
  "AWS.Website.SolidYield",
  { tags: ["provider:aws", "provider:aws:website", "live"] },
  () => {
    // The resource's reason to exist: a solid-yield app renders on the
    // client, so the deployment is assets-only and deep links fall back to
    // the shell without the caller configuring anything.
    test.provider(
      "deploys the solid-yield client build to S3 behind CloudFront with SPA fallback",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const rootDir = yield* cloneSolidYieldApp("alchemy-solid-yield-aws-live-");

          const deployed = yield* stack.deploy(
            Effect.gen(function* () {
              // Deliberately no `spa` — the default is what's under test.
              const site = yield* AWS.Website.SolidYield("SolidYieldSite", {
                rootDir,
                forceDestroy: true,
                invalidation: { paths: "all", wait: true },
              });
              return { site };
            }),
          );

          const url = deployed.site.url! as string;
          expect(url).toMatch(/^https:\/\//);
          // Assets-only: a solid-yield app is client-only, so the composite
          // never creates a server function.
          expect(deployed.site.server).toBeUndefined();
          expect(deployed.site.serverUrl).toBeUndefined();

          // The built index page serves from the edge, and its module script
          // is the compiled solid-yield app bundle.
          yield* expectSolidYieldBuild(url, { timeout: "180 seconds", label: "index" });
          // SPA fallback (the composite's default): a deep link boots the app
          // instead of 404ing.
          yield* expectUrlContains(`${url}/todos/42`, solidYieldPageMarker, {
            label: "spa fallback",
          });

          yield* stack.destroy();
        }),
      { timeout: 2_400_000 },
    );
  },
);
