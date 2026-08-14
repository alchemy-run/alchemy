import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as s3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { fileURLToPath } from "node:url";
import {
  expectDirectStatus,
  expectUrlContains,
} from "../../Cloudflare/Utils/Http.ts";
import EffectStaticSite, { SiteData } from "./fixtures/effect-static-site.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Gated: CloudFront Distribution create blocks on Status === "Deployed"
// (~5-15 min) and destroy requires disable -> wait -> delete (another
// ~5-15 min). Run with ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS=true (same gate
// as the AWS.CloudFront suites).
const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

const fixtureDir = fileURLToPath(
  new URL("./fixtures/static-site", import.meta.url),
);

const INDEX_MARKER = "alchemy-aws-staticsite-index-marker";
const ABOUT_MARKER = "alchemy-aws-staticsite-about-marker";
const CSS_MARKER = "alchemy-aws-staticsite-css-marker";

describe.skipIf(!runLive)("AWS.Website.StaticSite", () => {
  test.provider(
    "standalone SPA serves index, pretty URLs, and falls back on misses; errorPage update returns real 404s",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Phase 1: standalone SPA. Misses fall back to index.html with 200.
        const spa = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.StaticSite("Site", {
              path: fixtureDir,
              spa: true,
              forceDestroy: true,
              invalidation: { paths: "all", wait: true },
            });
            return { site };
          }),
        );

        const url = spa.site.url! as string;
        expect(url).toMatch(/^https:\/\//);

        // urls contract (cloudfront-default arm): a domain-less site
        // serves only at its CloudFront default domain, and `url` is
        // always `urls[0]`.
        expect(spa.site.urls).toEqual([
          `https://${spa.site.distribution!.domainName}`,
        ]);
        expect(url).toBe(spa.site.urls[0]);

        // Root serves the index page. Generous first-request budget: the
        // distribution just reached Deployed but edge propagation can lag.
        yield* expectUrlContains(`${url}/`, INDEX_MARKER, {
          timeout: "180 seconds",
          label: "index",
        });
        // Exact asset paths hit S3 (proves the OAC bucket policy works).
        yield* expectUrlContains(`${url}/styles.css`, CSS_MARKER, {
          label: "css asset",
        });
        // Pretty URL: /about -> about.html via the edge KV lookup.
        yield* expectUrlContains(`${url}/about`, ABOUT_MARKER, {
          label: "pretty url",
        });
        // SPA fallback: unknown path serves the app shell with a 200.
        yield* expectUrlContains(`${url}/missing/client/route`, INDEX_MARKER, {
          label: "spa fallback",
        });

        // Phase 2: switch to a real-404 static site with an error page.
        const site404 = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.StaticSite("Site", {
              path: fixtureDir,
              errorPage: "404.html",
              forceDestroy: true,
              invalidation: { paths: "all", wait: true },
            });
            return { site };
          }),
        );

        const url404 = site404.site.url! as string;
        // Content still serves.
        yield* expectUrlContains(`${url404}/about`, ABOUT_MARKER, {
          label: "pretty url after update",
        });
        // Misses now return a real 404 status.
        yield* expectDirectStatus(`${url404}/definitely/not/here`, 404, {
          timeout: "120 seconds",
          label: "404 status",
        });

        const distributionId = site404.site.distribution!.distributionId;

        yield* stack.destroy();
        yield* assertDistributionDeleted(distributionId);
      }),
    { timeout: 2_400_000 },
  );

  /**
   * Effectful StaticSite (DESIGN §4.2): the Effect program IS the server —
   * an effect-native Lambda behind the site's CloudFront distribution. One
   * distribution serves both surfaces: the generated edge router forwards
   * the default `server.routes` (`/api/*`) to the server Lambda BEFORE the
   * asset manifest (so `spa: true` never swallows an API path and an
   * uploaded file can never shadow one), and everything else keeps the
   * static/SPA behavior. The S3 binding collected from the impl proves the
   * deploy-time env + IAM channel end-to-end.
   */
  test.provider(
    "effectful StaticSite: /api/* reaches the effect Lambda under spa, S3 binding roundtrips, destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* EffectStaticSite;
            // The impl's `yield* SiteData` registers the bucket at the
            // root (registration is idempotent per FQN) — this resolves
            // the SAME row the binding uses.
            const data = yield* SiteData;
            return { data, site };
          }),
        );

        const url = deployed.site.url! as string;
        expect(url).toMatch(/^https:\/\//);
        // The server Lambda deployed with a real Function URL.
        expect(deployed.site.serverUrl).toMatch(/^https:\/\//);

        // Static surface: index, SPA fallback, and a real asset. Generous
        // first-request budget for edge propagation.
        yield* expectUrlContains(`${url}/`, INDEX_MARKER, {
          timeout: "180 seconds",
          label: "effectful index",
        });
        yield* expectUrlContains(`${url}/missing/client/route`, INDEX_MARKER, {
          label: "effectful spa fallback",
        });
        yield* expectUrlContains(`${url}/styles.css`, CSS_MARKER, {
          label: "effectful css asset",
        });

        // `/api/*` reaches the effect fetch through the SAME distribution
        // — spa:true and the API coexist.
        yield* expectUrlContains(`${url}/api/ping`, '"pong":true', {
          timeout: "120 seconds",
          label: "effectful api ping",
        });

        // RPC wire protocol: the server Lambda dispatches
        // POST /api/__rpc/<method> rpc-first, and the edge router forwards
        // the universal rpc claim alongside `server.routes`.
        const rpc = yield* HttpClient.execute(
          HttpClientRequest.post(`${url}/api/__rpc/greet`).pipe(
            HttpClientRequest.bodyText('["live"]', "application/json"),
          ),
        ).pipe(
          Effect.filterOrFail(
            (res): boolean => res.status === 200,
            (res) => new Error(`rpc expected 200, got ${res.status}`),
          ),
          Effect.retry({ schedule: Schedule.spaced("3 seconds"), times: 10 }),
        );
        expect(yield* rpc.json).toEqual({ value: "hello live" });

        // S3 binding roundtrip: the impl's PutObject/GetObject bindings
        // carried the bucket env var + IAM onto the server Lambda.
        const marker = `alchemy-aws-effectful-s3-roundtrip-${Date.now()}`;
        yield* expectUrlContains(
          `${url}/api/s3?key=current&put=${marker}`,
          `"value":"${marker}"`,
          { timeout: "60 seconds", label: "effectful s3 put+get" },
        );

        // Out-of-band proof via distilled: the write landed in the real
        // bucket.
        const object = yield* s3
          .getObject({
            Bucket: deployed.data.bucketName,
            Key: "current",
          })
          .pipe(Effect.orDie);
        const body = yield* Stream.mkString(
          Stream.decodeText(object.Body!),
        ).pipe(Effect.orDie);
        expect(body).toBe(marker);

        // An unmatched /api/* path returns the effect fetch's own 404 —
        // never the SPA shell (the edge router owns the split).
        yield* expectDirectStatus(`${url}/api/definitely-not-here`, 404, {
          timeout: "60 seconds",
          label: "effectful api 404",
        });

        const distributionId = deployed.site.distribution!.distributionId;
        const functionName = deployed.site.server.functionName;

        yield* stack.destroy();
        yield* assertDistributionDeleted(distributionId);

        // The server Lambda is gone too.
        const fnGone = yield* Lambda.getFunction({
          FunctionName: functionName,
        }).pipe(
          Effect.map(() => false),
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(true),
          ),
          Effect.orDie,
          Effect.repeat({
            schedule: Schedule.spaced("2 seconds"),
            until: (gone): boolean => gone,
            times: 30,
          }),
        );
        expect(fnGone).toBe(true);
      }),
    { timeout: 2_400_000 },
  );
});

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
