import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as S3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { pathToFileURL } from "node:url";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Gated with the rest of the AWS.Website suites: the CloudFront lifecycle
// dominates the runtime (create ~5-15 min, destroy ~5-15 min).
const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "sveltekit-app",
);

// Clone under the alchemy package so `@sveltejs/kit`/`svelte`/`vite`
// resolve from the workspace's hoisted node_modules (the fixture has no
// node_modules).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [".gitignore", "package.json", "src", "static"];

describe.skipIf(!runLive)("AWS.Website.SvelteKit", () => {
  test.provider(
    "deploys SSR on a streaming Lambda URL with S3 assets behind CloudFront",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-sveltekit-aws-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.SvelteKit("SvelteKitSite", {
              rootDir,
              forceDestroy: true,
              invalidation: { paths: "all", wait: true },
            });
            return { site };
          }),
        );

        const url = deployed.site.url! as string;
        expect(url).toMatch(/^https:\/\//);
        expect(deployed.site.serverUrl).toBeDefined();
        yield* Effect.log(
          `site url: ${url} | server url: ${deployed.site.serverUrl}`,
        );

        // The Lambda Function URL serves the SSR page directly — isolates
        // server-function health from the CloudFront edge routing.
        yield* expectUrlContains(
          `${deployed.site.serverUrl!}`,
          "SVELTEKIT_AWS_PAGE_MARKER",
          {
            timeout: "120 seconds",
            label: "SSR direct from Lambda URL",
          },
        );

        // SSR page rendered by the Lambda through CloudFront.
        yield* expectUrlContains(`${url}/`, "SVELTEKIT_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "SSR home page",
        });
        // Server API route through the streaming Function URL origin.
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "SVELTEKIT_AWS_API_MARKER",
          { label: "API route" },
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "roundtrip",
          { label: "API route query echo" },
        );
        // Static file served from S3 via the KV file manifest.
        yield* expectUrlContains(
          `${url}/robots.txt`,
          "sveltekit-aws-robots-marker",
          {
            label: "static asset from S3",
          },
        );
        // Prerendered page (kit wrote `prerendered.html` into the assets
        // directory at build time; the edge router's `.html` fallback
        // serves it from S3).
        yield* expectUrlContains(
          `${url}/prerendered`,
          "SVELTEKIT_AWS_PRERENDERED_MARKER",
          { label: "prerendered page" },
        );

        const distributionId = deployed.site.distribution!.distributionId;

        if (!process.env.NO_DESTROY) {
          yield* stack.destroy();
          yield* assertDistributionDeleted(distributionId);
        }
      }),
    { timeout: 2_400_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // Effectful SvelteKit (DESIGN §6.2b / §7-AWS): ONE Lambda serves kit's
  // SSR AND the Effect-native API. Wrapper delivery — the AWS deploy
  // target's generated Lambda entry composes
  // `site.match(request) ?? respond(request)` inside the one
  // `streamifyResponse` wrap; the CloudFront edge router forwards
  // `server.routes` to the server BEFORE the static-asset manifest.
  // ─────────────────────────────────────────────────────────────────────

  const effectFixtureDir = pathe.resolve(
    import.meta.dirname,
    "fixtures",
    "sveltekit-effect-app",
  );

  test.provider(
    "effectful SvelteKit: effect fetch owns /api/* with S3 bindings + streamed bodies; the exclusion glob routes /api/hello to kit",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(effectFixtureDir, {
          prefix: "alchemy-sveltekit-aws-effect-",
          tempRoot,
          entries: [".gitignore", "package.json", "src"],
        });

        // The site module is cloned with the fixture, so it is imported
        // dynamically from the clone (its `rootDir` prop derives from its
        // own location).
        const siteModule = (yield* Effect.tryPromise(
          () =>
            import(pathToFileURL(pathe.join(rootDir, "src", "site.ts")).href),
        )) as typeof import("./fixtures/sveltekit-effect-app/src/site.ts");

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const data = yield* siteModule.SiteData;
            const site = yield* siteModule.default;
            return { data, site };
          }),
        );

        const url = deployed.site.url! as string;
        expect(url).toMatch(/^https:\/\//);
        const serverUrl = deployed.site.serverUrl! as string;
        expect(serverUrl).toBeDefined();
        yield* Effect.log(`site url: ${url} | server url: ${serverUrl}`);

        // ── Effect surface, direct from the streaming Function URL —
        // isolates the wrapper + layer build from the edge routing ────────
        const s3Value = `sveltekit-aws-effect-live-${crypto.randomUUID()}`;
        yield* expectUrlContains(
          `${serverUrl}api/effect/s3?key=live&put=${s3Value}`,
          s3Value,
          { timeout: "180 seconds", label: "effect S3 write (Lambda URL)" },
        );

        // ── Effect surface through CloudFront: the edge serverRoutes
        // check forwards /api/* to the server before the asset manifest ───
        yield* expectUrlContains(`${url}/api/effect/s3?key=live`, s3Value, {
          timeout: "180 seconds",
          label: "effect S3 read (CloudFront)",
        });

        // Out-of-band: the write landed in the REAL bucket (the collected
        // IAM policy statements on the server Lambda's role made it
        // possible).
        const cloudBody = yield* S3.getObject({
          Bucket: deployed.data.bucketName,
          Key: "live",
        }).pipe(
          Effect.flatMap((res) =>
            Stream.mkString(Stream.decodeText(res.Body!)),
          ),
          Effect.retry({
            schedule: Schedule.exponential("1 second", 1.5),
            times: 5,
          }),
        );
        expect(cloudBody).toBe(s3Value);

        // ── Streamed effect response through the RESPONSE_STREAM pipe —
        // both direct and through CloudFront ─────────────────────────────
        yield* expectUrlContains(
          `${serverUrl}api/effect/stream`,
          siteModule.STREAM_MARKER,
          { timeout: "60 seconds", label: "streamed effect body (Lambda URL)" },
        );
        yield* expectUrlContains(
          `${url}/api/effect/stream`,
          siteModule.STREAM_MARKER,
          { timeout: "60 seconds", label: "streamed effect body (CloudFront)" },
        );

        // ── Exclusion glob: /api/hello is carved OUT of the effect claim
        // (`!/api/hello` in server.routes), so kit's own +server endpoint
        // answers — the effect fetch never sees the path ─────────────────
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "SVELTEKIT_AWS_EFFECT_KIT_API",
          { label: "exclusion glob routes to kit" },
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "roundtrip",
          {
            label: "kit endpoint query echo",
          },
        );

        // ── An unknown route INSIDE the claim is the effect's own 404 —
        // the fixture's RouteNotFound failure renders as the fetch's OWN
        // 404 response (empty body, not kit's HTML error page) ───────────
        const insideMiss = yield* expectStatus(
          `${url}/api/effect/definitely-not-here`,
          404,
        );
        expect(insideMiss.body).not.toContain("<html");

        // ── Framework surface: kit SSR through CloudFront ────────────────
        yield* expectUrlContains(
          `${url}/`,
          "SVELTEKIT_AWS_EFFECT_PAGE_MARKER",
          {
            timeout: "180 seconds",
            label: "kit SSR home",
          },
        );

        const distributionId = deployed.site.distribution!.distributionId;
        const bucketName = deployed.data.bucketName;

        if (!process.env.NO_DESTROY) {
          yield* stack.destroy();
          yield* assertDistributionDeleted(distributionId);
          // The impl-bound bucket is gone too (forceDestroy drained it).
          yield* S3.headBucket({ Bucket: bucketName }).pipe(
            Effect.flatMap(() => Effect.fail(new Error("BucketStillExists"))),
            Effect.retry({
              while: (e): boolean =>
                e instanceof Error && e.message === "BucketStillExists",
              schedule: Schedule.max([
                Schedule.exponential("200 millis"),
                Schedule.recurs(10),
              ]),
            }),
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.catch(() => Effect.void),
          );
        }
      }),
    { timeout: 2_400_000 },
  );
});

/**
 * Fetch `url` until it answers `status` — for real-404 assertions
 * `expectUrlContains` can't make (it requires `res.ok`). Returns the final
 * body so callers can also assert WHO answered.
 */
const expectStatus = (url: string, status: number) =>
  Effect.tryPromise(async (signal) => {
    const res = await fetch(url, {
      signal,
      cache: "no-store",
      headers: { "cache-control": "no-cache", accept: "*/*" },
    });
    return { status: res.status, body: await res.text() };
  }).pipe(
    Effect.filterOrFail(
      (r) => r.status === status,
      (r) =>
        new Error(
          `expected ${status} from ${url}, got ${r.status}: ${r.body.slice(0, 300)}`,
        ),
    ),
    Effect.retry({
      schedule: Schedule.exponential("1 second", 1.5),
      times: 6,
    }),
  );

const assertDistributionDeleted = (distributionId: string) =>
  cloudfront.getDistribution({ Id: distributionId }).pipe(
    Effect.flatMap(() => Effect.fail(new Error("DistributionStillExists"))),
    Effect.catchTag("NoSuchDistribution", () => Effect.void),
    Effect.retry({
      while: (error): boolean =>
        error instanceof Error && error.message === "DistributionStillExists",
      schedule: Schedule.max([
        Schedule.fixed("10 seconds"),
        Schedule.recurs(60),
      ]),
    }),
  );
