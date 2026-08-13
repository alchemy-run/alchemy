import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as s3 from "@distilled.cloud/aws/s3";
import * as sqs from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nuxt-app");

// Clone under the alchemy package so `nuxt`/`nitropack` resolve from the
// workspace's hoisted node_modules (the fixture has no node_modules).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "nuxt.config.ts",
  "app",
  "server",
  "public",
];

describe.skipIf(!runLive)("AWS.Website.Nuxt", () => {
  test.provider(
    "deploys SSR on a streaming Lambda URL with S3 assets behind CloudFront",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-aws-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.Nuxt("NuxtSite", {
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
          "NUXT_AWS_PAGE_MARKER",
          {
            timeout: "120 seconds",
            label: "SSR direct from Lambda URL",
          },
        );

        // SSR page rendered by the Lambda through CloudFront.
        yield* expectUrlContains(`${url}/`, "NUXT_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "SSR home page",
        });
        // The fixture's own nuxt.config.ts applied (runtimeConfig marker).
        yield* expectUrlContains(
          `${url}/`,
          "config:nuxt-aws-user-config-loaded",
          {
            label: "user nuxt.config.ts applied",
          },
        );
        // Server API route through the streaming Function URL origin.
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "NUXT_AWS_API_MARKER",
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
          "nuxt-aws-robots-marker",
          {
            label: "public asset from S3",
          },
        );
        // Prerendered page (nitro wrote it into .output/public at build
        // time; the edge router serves it from S3 by exact match).
        yield* expectUrlContains(
          `${url}/prerendered`,
          "NUXT_AWS_PRERENDERED_MARKER",
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

  test.provider(
    "serves SSR through a shared Router distribution with Lambda env applied",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-aws-router-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const router = yield* AWS.Website.Router("FrontDoor", {
              invalidation: { paths: "all", wait: true },
            });
            const site = yield* AWS.Website.Nuxt("NuxtSite", {
              rootDir,
              forceDestroy: true,
              domain: { router },
              server: {
                environment: {
                  NUXT_PUBLIC_ENV_MARKER: "nuxt-aws-live-env-marker",
                },
              },
            });
            return { router, site };
          }),
        );

        const url = deployed.router.url as string;
        expect(url).toMatch(/^https:\/\//);

        // SSR through the ROUTER's distribution (the site registered
        // itself in the router's KV store — no site-owned distribution).
        expect(deployed.site.distribution).toBeUndefined();
        // Generous budget: a fresh router distribution's KVS association +
        // function propagation can lag past 180s on first serve.
        yield* expectUrlContains(`${url}/`, "NUXT_AWS_PAGE_MARKER", {
          timeout: "300 seconds",
          label: "SSR via router",
        });
        // Lambda env applied on deploy (parity with the dev-server
        // injection asserted in Nuxt.local.test.ts).
        yield* expectUrlContains(`${url}/`, "env:nuxt-aws-live-env-marker", {
          label: "server.environment on the Lambda",
        });
        // The router's defaultTTL-0 cache policy must not cache SSR
        // responses: two fetches of an SSR page with a per-request value
        // would prove staleness, but the page is deterministic — instead
        // assert the API route (dynamic, no cache-control) round-trips
        // with distinct query strings, which a day-long cached body under
        // CachingOptimized would break.
        yield* expectUrlContains(
          `${url}/api/hello?echo=router-one`,
          "router-one",
          { label: "API via router (query one)" },
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=router-two`,
          "router-two",
          { label: "API via router (query two)" },
        );
        // Static asset from S3 through the router's edge function.
        yield* expectUrlContains(
          `${url}/robots.txt`,
          "nuxt-aws-robots-marker",
          {
            label: "public asset via router",
          },
        );
        // Prerendered page from S3 by exact match.
        yield* expectUrlContains(
          `${url}/prerendered`,
          "NUXT_AWS_PRERENDERED_MARKER",
          { label: "prerendered page via router" },
        );

        const distributionId = deployed.router.distributionId as string;

        if (!process.env.NO_DESTROY) {
          yield* stack.destroy();
          yield* assertDistributionDeleted(distributionId);
        }
      }),
    { timeout: 2_400_000 },
  );
});

// ─────────────────────────────────────────────────────────────────────
// Effectful Nuxt live (explicit tier + sibling, DESIGN §2.1.3 / §7-AWS):
// ONE Website whose Effect program owns /api/effect/* through the
// `toEventHandler` middleware compiled into the nitro Lambda (collect-only
// mode — the artifact ships as-is, bindings collected env + IAM at plan),
// while its SQS consumer rides the SIBLING effect Lambda deployed from the
// same site module with the event-source mapping targeting it.
// ─────────────────────────────────────────────────────────────────────

/**
 * The live effectful site module (written into the clone at `src/site.ts`;
 * the clone sits at `packages/alchemy/.tmp/<dir>/`, so `../../../src` is
 * `packages/alchemy/src` — the CURRENT sources, compiled by nitro into the
 * server bundle and by FunctionBundle into the sibling).
 */
const nuxtEffectLiveSiteSource = `
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as NodePath from "node:path";
import { QueueEventSource } from "../../../src/AWS/Lambda/QueueEventSource.ts";
import { Bucket } from "../../../src/AWS/S3/Bucket.ts";
import { GetObject } from "../../../src/AWS/S3/GetObject.ts";
import { GetObjectHttp } from "../../../src/AWS/S3/GetObjectHttp.ts";
import { PutObject } from "../../../src/AWS/S3/PutObject.ts";
import { PutObjectHttp } from "../../../src/AWS/S3/PutObjectHttp.ts";
import { Queue } from "../../../src/AWS/SQS/Queue.ts";
import { consumeQueueMessages } from "../../../src/AWS/SQS/QueueEventSource.ts";
import { Nuxt } from "../../../src/AWS/Website/Nuxt.ts";

/** S3 bucket bound by both surfaces (fetch round-trip + queue handler). */
export const SiteData = Bucket("NuxtEffectLiveData", { forceDestroy: true });

/** SQS queue consumed by the sibling effect Lambda. */
export const Jobs = Queue("NuxtEffectLiveJobs", {
  // Lambda event-source polling needs the visibility timeout to cover the
  // consumer function's timeout (30s) with headroom.
  visibilityTimeout: "2 minutes",
});

export default class NuxtEffectLiveSite extends Nuxt<NuxtEffectLiveSite>()(
  "NuxtEffectSite",
  {
    main: import.meta.url,
    // Plan-only (guarded: undefined when the module re-evaluates inside a
    // deployed bundle where import.meta has no path).
    rootDir: import.meta.dirname
      ? NodePath.dirname(import.meta.dirname)
      : undefined,
  },
  Effect.gen(function* () {
    const bucket = yield* SiteData;
    const queue = yield* Jobs;
    const putObject = yield* PutObject(bucket);
    const getObject = yield* GetObject(bucket);

    // Non-fetch surface (rides the sibling effect Lambda): each SQS
    // message body is written to the bucket so the test can observe
    // delivery out-of-band.
    yield* consumeQueueMessages(queue, (records) =>
      records.pipe(
        Stream.runForEach((record) =>
          putObject({
            Key: \`sqs/\${record.body}\`,
            Body: record.body,
          }).pipe(Effect.orDie),
        ),
        Effect.orDie,
      ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://fixture");
        if (url.pathname === "/api/effect/ping") {
          return yield* HttpServerResponse.json({ marker: "effect-fetch" });
        }
        if (url.pathname === "/api/effect/s3") {
          const key = url.searchParams.get("key") ?? "current";
          const put = url.searchParams.get("put");
          if (put !== null) {
            yield* putObject({ Key: key, Body: put }).pipe(Effect.orDie);
          }
          const object = yield* getObject({ Key: key }).pipe(Effect.orDie);
          const value =
            object.Body === undefined
              ? undefined
              : yield* Stream.mkString(Stream.decodeText(object.Body)).pipe(
                  Effect.orDie,
                );
          return yield* HttpServerResponse.json({ value });
        }
        // Unknown path INSIDE the claim: the effect fetch is authoritative
        // here, so this is its OWN 404 — never delegation to nitro (paths
        // outside the middleware's routes never reach this fetch at all).
        return HttpServerResponse.json(
          { marker: "effect-404" },
          { status: 404 },
        );
      }),
    };
  }).pipe(
    Effect.provide([PutObjectHttp, GetObjectHttp]),
    Effect.provide(QueueEventSource),
  ),
) {}
`;

/**
 * The explicit-tier mount (`server/middleware/alchemy.ts` in the clone).
 * `routes` decides who serves each path — inside them the effect fetch is
 * authoritative; the `!/api/hello` exclusion glob carves nitro's own API
 * route out of the claim.
 */
const nuxtLiveMiddlewareSource = [
  `import { toEventHandler } from "../../../../src/Serve/nitro.ts";`,
  `import Site from "../../src/site.ts";`,
  `export default toEventHandler(Site, { routes: ["/api/*", "!/api/hello"] });`,
  ``,
].join("\n");

/** GET `url` until it answers 200 JSON — bounded. */
const fetchJsonReady = <T>(url: string, times = 40) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        Effect.flatMap(res.text, (body) =>
          res.status === 200
            ? Effect.try({
                try: () => JSON.parse(body) as T,
                catch: () => new Error(`non-json body: ${body.slice(0, 300)}`),
              })
            : Effect.fail(
                new Error(`not ready (${res.status}): ${body.slice(0, 300)}`),
              ),
        ),
      ),
      Effect.retry({ schedule: Schedule.spaced("3 seconds"), times }),
    );
  });

describe.skipIf(!runLive)("AWS.Website.Nuxt (effectful)", () => {
  test.provider(
    "effectful site: /api/effect/* through the edge serverRoutes + queue handler on the sibling Lambda",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-aws-effect-",
          tempRoot,
          entries: fixtureEntries,
        });
        yield* fs.makeDirectory(path.join(rootDir, "src"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(rootDir, "src", "site.ts"),
          nuxtEffectLiveSiteSource,
        );
        yield* fs.makeDirectory(path.join(rootDir, "server", "middleware"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(rootDir, "server", "middleware", "alchemy.ts"),
          nuxtLiveMiddlewareSource,
        );

        const mod = (yield* Effect.tryPromise(
          () =>
            import(pathToFileURL(path.join(rootDir, "src", "site.ts")).href),
        )) as {
          default: any;
          SiteData: Effect.Effect<AWS.S3.Bucket, never, any>;
          Jobs: Effect.Effect<AWS.SQS.Queue, never, any>;
        };

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            // Idempotent per-FQN registration: these resolve the SAME rows
            // the impl's bindings use.
            const data = yield* mod.SiteData;
            const jobs = yield* mod.Jobs;
            const site = yield* mod.default;
            return { data, jobs, site };
          }),
        );

        const url = deployed.site.url! as string;
        expect(url).toMatch(/^https:\/\//);
        yield* Effect.log(
          `site url: ${url} | server url: ${deployed.site.serverUrl}`,
        );

        // SSR still serves (the collect-only artifact shipped as-is).
        yield* expectUrlContains(`${url}/`, "NUXT_AWS_PAGE_MARKER", {
          timeout: "300 seconds",
          label: "SSR home page (effectful)",
        });
        // Nitro's own API route is carved OUT of the effect claim by the
        // `!/api/hello` exclusion glob — the middleware declines the path
        // and nitro's handler answers.
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "NUXT_AWS_API_MARKER",
          { label: "exclusion glob routes to nitro" },
        );

        // Effect fetch through CloudFront: the edge serverRoutes check
        // forwards /api/* to the server BEFORE the asset manifest.
        const ping = yield* fetchJsonReady<{ marker: string }>(
          `${url}/api/effect/ping`,
        );
        expect(ping.marker).toBe("effect-fetch");

        // An unknown route INSIDE the claim is the effect's own 404 — the
        // fetch's marker body proves WHO answered (never nitro's 404),
        // through the same edge serverRoutes path.
        const insideMiss = yield* Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const res = yield* client.get(`${url}/api/definitely-not-here`);
          return { status: res.status, body: yield* res.text };
        });
        expect(insideMiss.status).toBe(404);
        expect(insideMiss.body).toContain("effect-404");

        // S3 round-trip through the binding collected onto the server
        // Lambda (env + IAM). Random payload defeats stale objects.
        const value = `nuxt-aws-effect-live-${crypto.randomUUID()}`;
        const written = yield* fetchJsonReady<{ value: string | undefined }>(
          `${url}/api/effect/s3?key=greeting&put=${value}`,
        );
        expect(written.value).toBe(value);

        // Out-of-band: the write landed in the real bucket.
        const observedFetchWrite = yield* s3
          .getObject({
            Bucket: deployed.data.bucketName as string,
            Key: "greeting",
          })
          .pipe(
            Effect.flatMap((res) =>
              Stream.mkString(Stream.decodeText(res.Body!)),
            ),
            Effect.retry({
              schedule: Schedule.exponential("1 second", 1.5),
              times: 6,
            }),
          );
        expect(observedFetchWrite).toBe(value);

        // ── Sibling non-fetch delivery: send an SQS message out-of-band;
        // the SIBLING effect Lambda's consumer writes it to the bucket ──
        const messageBody = `sibling-${crypto.randomUUID()}`;
        yield* sqs.sendMessage({
          QueueUrl: deployed.jobs.queueUrl as string,
          MessageBody: messageBody,
        });
        const observedSibling = yield* s3
          .getObject({
            Bucket: deployed.data.bucketName as string,
            Key: `sqs/${messageBody}`,
          })
          .pipe(
            Effect.flatMap((res) =>
              Stream.mkString(Stream.decodeText(res.Body!)),
            ),
            Effect.retry({
              while: (error): boolean =>
                "_tag" in error && error._tag === "NoSuchKey",
              schedule: Schedule.spaced("5 seconds"),
              times: 36,
            }),
          );
        expect(observedSibling).toBe(messageBody);

        const distributionId = deployed.site.distribution!.distributionId;

        if (!process.env.NO_DESTROY) {
          yield* stack.destroy();
          yield* assertDistributionDeleted(distributionId);
        }
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
