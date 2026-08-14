import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Gated with the rest of the AWS.Website suites: the CloudFront lifecycle
// dominates the runtime (create ~5-15 min, destroy ~5-15 min).
const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "astro-app");
const effectFixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "astro-effect-app",
);

// Clone under the alchemy package so `astro` resolves from the workspace's
// hoisted node_modules (the fixture has no node_modules).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "astro.config.mjs",
  "src",
  "public",
];

describe.skipIf(!runLive)("AWS.Website.Astro", () => {
  test.provider(
    "deploys SSR on a streaming Lambda URL with S3 assets behind CloudFront",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-astro-aws-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.Astro("AstroSite", {
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
          "ASTRO_AWS_PAGE_MARKER",
          {
            timeout: "120 seconds",
            label: "SSR direct from Lambda URL",
          },
        );

        // SSR page rendered by the Lambda through CloudFront.
        yield* expectUrlContains(`${url}/`, "ASTRO_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "SSR home page",
        });
        // API route through the streaming Function URL origin.
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "ASTRO_AWS_API_MARKER",
          { label: "API route" },
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "roundtrip",
          { label: "API route query echo" },
        );
        // Public file served from S3 via the KV file manifest.
        yield* expectUrlContains(
          `${url}/robots.txt`,
          "astro-aws-robots-marker",
          {
            label: "public asset from S3",
          },
        );
        // Prerendered page (astro wrote it into dist/client at build time;
        // the edge router serves it from S3 by directory-index match).
        yield* expectUrlContains(
          `${url}/prerendered/`,
          "ASTRO_AWS_PRERENDERED_MARKER",
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
  // Effectful Website (DESIGN §6.2c, §7-AWS): one Lambda serves the Astro
  // frontend AND the Effect program's API. The AWS deploy target
  // pre-resolves `virtual:astro:fetchable` to a generated wrapper mounting
  // the AWS serve shell; the DynamoDB bindings collected at plan land as
  // env vars + IAM on the collect-only server Lambda; the CloudFront edge
  // router forwards `server.routes` to the server BEFORE the asset
  // manifest; the deploy-time sentinel scan finds the shell's sentinel
  // bundled into `dist/server`.
  // ─────────────────────────────────────────────────────────────────────

  test.provider(
    "effectful Astro: /api/* reaches the effect fetch, SSR + prerender + static ride along, destroy",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Private clone; the clone's own `site.ts` is the program module
        // (`main: import.meta.url` anchors the cloned path).
        const rootDir = yield* cloneFixture(effectFixtureDir, {
          prefix: "alchemy-astro-effect-aws-",
          tempRoot,
          entries: [
            ".gitignore",
            "package.json",
            "astro.config.mjs",
            "public",
            "site.ts",
            "src",
          ],
        });
        const siteModule = (yield* Effect.promise(
          () => import(pathe.join(rootDir, "site.ts")),
        )) as typeof import("./fixtures/astro-effect-app/site.ts");

        const { site, table } = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* siteModule.default;
            // The impl's `yield* Visits` registers the table at the root
            // (registration is idempotent per FQN) — this resolves the
            // SAME row the bindings use.
            const table = yield* siteModule.Visits;
            return { site, table };
          }),
        );

        const url = site.url! as string;
        expect(url).toMatch(/^https:\/\//);
        const serverUrl = site.serverUrl! as string;
        expect(serverUrl).toMatch(/^https:\/\//);
        yield* Effect.log(`site url: ${url} | server url: ${serverUrl}`);

        // ── direct against the Lambda Function URL first — isolates
        // server-function health from the CloudFront edge routing ──────
        yield* expectUrlContains(serverUrl, "astro-aws-effect-home", {
          timeout: "120 seconds",
          label: "effectful SSR direct from Lambda URL",
        });
        // The effect fetch answers through the SAME Lambda (the fetchable
        // wrapper runs inside the framework bundle).
        yield* expectUrlContains(
          new URL("/api/marker", serverUrl).toString(),
          "astro-aws-effect-fetch",
          { timeout: "60 seconds", label: "effectful api direct from Lambda" },
        );

        // ── through CloudFront ─────────────────────────────────────────
        yield* expectUrlContains(`${url}/`, "astro-aws-effect-home", {
          timeout: "180 seconds",
          label: "effectful SSR home",
        });
        yield* expectUrlContains(
          `${url}/api/marker`,
          "astro-aws-effect-fetch",
          { timeout: "60 seconds", label: "effectful api marker" },
        );

        // RPC wire protocol: the serve shell dispatches
        // POST /api/__rpc/<method> rpc-first, and the edge rides the
        // universal rpc claim alongside the routes.
        const rpc = yield* HttpClient.execute(
          HttpClientRequest.post(`${url}/api/__rpc/greet`).pipe(
            HttpClientRequest.bodyText('["live"]', "application/json"),
          ),
        ).pipe(
          Effect.filterOrFail(
            (res): boolean => res.status === 200,
            (res) =>
              new LiveResponseMismatch({
                url: `${url}/api/__rpc/greet`,
                detail: `expected 200, got ${res.status}`,
              }),
          ),
          Effect.retry({
            schedule: Schedule.min([
              Schedule.exponential("1 second", 1.5),
              Schedule.spaced("5 seconds"),
            ]),
            times: 10,
          }),
        );
        expect(yield* rpc.json).toEqual({ value: "hello live" });

        // DynamoDB round-trip through the capability bindings (table-name
        // env var + IAM collected onto the server Lambda at plan).
        const marker = `astro-aws-effect-live-${Date.now()}`;
        yield* expectUrlContains(
          `${url}/api/db?key=current&put=${marker}`,
          `"value":"${marker}"`,
          { timeout: "60 seconds", label: "effectful dynamodb put+get" },
        );

        // Out-of-band proof via distilled: the write landed in the real
        // table.
        const item = yield* dynamodb
          .getItem({
            TableName: table.tableName,
            Key: { pk: { S: "current" } },
            ConsistentRead: true,
          })
          .pipe(Effect.orDie);
        expect(item.Item?.value?.S).toBe(marker);

        // Exclusion glob: `/api/astro-echo` is carved OUT of the effect
        // claim (`!/api/astro-echo` in server.routes), so Astro's own
        // endpoint answers — the effect fetch never sees the path.
        yield* expectUrlContains(
          `${url}/api/astro-echo`,
          "astro-endpoint-echo",
          { timeout: "60 seconds", label: "exclusion glob routes to astro" },
        );

        // An unknown route INSIDE the claim is the effect fetch's own 404
        // (its RouteNotFound failure renders as its OWN 404 response) — a
        // REAL 404, never delegation and never a SPA shell.
        yield* expectStatus(`${url}/api/definitely-not-here`, 404);

        // Prerendered page: astro wrote it into dist/client at build time
        // (the prerender environment never loads the effect wrapper — the
        // guard case); the edge router serves it from S3 by
        // directory-index match.
        yield* expectUrlContains(
          `${url}/about/`,
          "astro-aws-effect-prerendered",
          { timeout: "60 seconds", label: "effectful prerendered page" },
        );

        // Public file served from S3 via the KV file manifest.
        yield* expectUrlContains(
          `${url}/static.txt`,
          "astro-aws-effect-static-asset",
          { label: "effectful static asset" },
        );

        const distributionId = site.distribution!.distributionId;
        const functionName = site.server.functionName;

        if (!process.env.NO_DESTROY) {
          yield* stack.destroy();
          yield* assertDistributionDeleted(distributionId);

          // The server Lambda is gone.
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

          // ...and so is the impl-bound table.
          const tableGone = yield* dynamodb
            .describeTable({ TableName: table.tableName })
            .pipe(
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
          expect(tableGone).toBe(true);
        }
      }),
    { timeout: 2_400_000 },
  );
});

class LiveResponseMismatch extends Data.TaggedError("LiveResponseMismatch")<{
  url: string;
  detail: string;
}> {
  override get message() {
    return `${this.url} :: ${this.detail}`;
  }
}

/**
 * Fetch `url` until it answers exactly `status` — for real-404 assertions
 * `expectUrlContains` can't make (it requires `res.ok`). Bounded retry
 * rides out edge propagation.
 */
const expectStatus = (url: string, status: number) =>
  Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(url, {
        signal,
        cache: "no-store",
        headers: { "cache-control": "no-cache", accept: "*/*" },
      });
      return { status: res.status, body: await res.text() };
    },
    catch: (e) =>
      new LiveResponseMismatch({
        url,
        detail: e instanceof Error ? e.message : String(e),
      }),
  }).pipe(
    Effect.filterOrFail(
      (r) => r.status === status,
      (r) =>
        new LiveResponseMismatch({
          url,
          detail: `expected ${status}, got ${r.status} ${r.body.slice(0, 240)}`,
        }),
    ),
    Effect.retry({
      schedule: Schedule.min([
        Schedule.exponential("1 second", 1.5),
        Schedule.spaced("5 seconds"),
      ]),
      times: 12,
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
