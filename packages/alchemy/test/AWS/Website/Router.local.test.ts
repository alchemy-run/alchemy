import * as AWS from "@/AWS";
import { DEFAULT_LOCAL_ENDPOINT } from "@/AWS/AuthProvider.ts";
import { flociServices } from "@/AWS/Local/FlociServices.ts";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
//
// These cases need floci's emulated CloudFront edge, which arrives with the
// next `DEFAULT_FLOCI_IMAGE` pin bump. Until then, run them against a locally
// built emulator: `ALCHEMY_FLOCI_IMAGE=floci:cf-edge pnpm test …`.
const { test } = Test.make({ providers: AWS.providers(), dev: true });

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "staticsite-dev",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const htmlPage = (marker: string) => `<!doctype html>
<html>
  <head><title>${marker}</title></head>
  <body><h1>${marker}</h1></body>
</html>
`;

/**
 * Fetch through the emulated CloudFront edge.
 *
 * The distribution's `*.cloudfront.net` domain is a real AWS hostname that
 * resolves to nothing locally, so the request goes to the emulator with the
 * Host preserved — exactly what `rewriteAwsVirtualHostToFloci` does for
 * `ALCHEMY_TEST_DEV` runs, and what floci's virtual-host filters expect.
 */
const edgeFetch = Effect.fn("edgeFetch")(function* (
  routerUrl: string,
  path: string,
) {
  const client = yield* HttpClient.HttpClient;
  const host = new URL(routerUrl).host;
  return yield* client
    .execute(
      HttpClientRequest.get(`${DEFAULT_LOCAL_ENDPOINT}${path}`).pipe(
        HttpClientRequest.setHeader("host", host),
      ),
    )
    .pipe(
      Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 6 }),
    );
});

/**
 * Build one Router-attached dev site: a cloned fixture whose long-lived dev
 * server serves `site/<prefix>/index.html`, so the site behaves like a real
 * static host mounted under the Router's path prefix.
 */
const makeSiteFixture = Effect.fn("makeSiteFixture")(function* (
  prefix: string,
  marker: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* cloneFixture(fixtureDir, {
    prefix: `alchemy-aws-router-dev-${prefix}-`,
    tempRoot,
    entries: ["serve.mjs", "site"],
  });
  yield* fs.makeDirectory(path.join(cwd, "site", prefix), { recursive: true });
  yield* fs.writeFileString(
    path.join(cwd, "site", prefix, "index.html"),
    htmlPage(marker),
  );
  return cwd;
});

describe("AWS.Website.Router local", () => {
  /**
   * The whole point of the local Router: two sites, one Router, real HTTP
   * through the emulated CloudFront distribution, each path prefix reaching
   * its own dev server. No CloudFront deploy — the distribution, its KV
   * store, its viewer-request function and the routing all run in floci.
   */
  test.provider(
    "two dev sites route through one emulated distribution",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const cwdA = yield* makeSiteFixture("site-a", "router-dev-site-a");
        const cwdB = yield* makeSiteFixture("site-b", "router-dev-site-b");

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const router = yield* AWS.Website.Router("DevRouter", {});
            const siteA = yield* AWS.Website.StaticSite("SiteA", {
              path: cwdA,
              dev: { command: "bun serve.mjs", env: { DEV_MARKER: "site-a" } },
              domain: { router, path: "/site-a" },
            });
            const siteB = yield* AWS.Website.StaticSite("SiteB", {
              path: cwdB,
              dev: { command: "bun serve.mjs", env: { DEV_MARKER: "site-b" } },
              domain: { router, path: "/site-b" },
            });
            return {
              routerUrl: router.url,
              distributionId: router.distributionId,
              kvNamespace: router.kvNamespace,
              siteA: { url: siteA.url, kvNamespace: siteA.kvNamespace },
              siteB: { url: siteB.url, kvNamespace: siteB.kvNamespace },
            };
          }),
        );

        const routerUrl = deployed.routerUrl as string;
        // The Router is a real (emulated) CloudFront distribution — the same
        // resource graph a deploy produces, not a dev-only substitute.
        expect(routerUrl).toMatch(/^https:\/\/E[A-Z0-9]+\.cloudfront\.net$/);
        // Each site kept its own dev server as its `url` (HMR is the point of
        // dev) while still registering with the Router.
        expect(deployed.siteA.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(deployed.siteB.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(deployed.siteA.url).not.toBe(deployed.siteB.url);
        expect(deployed.siteA.kvNamespace).toBeDefined();
        expect(deployed.siteB.kvNamespace).not.toBe(deployed.siteA.kvNamespace);

        // ── Routing: each prefix reaches its own dev server ────────────────
        const a = yield* edgeFetch(routerUrl, "/site-a/");
        expect(a.status).toBe(200);
        expect(yield* a.text).toContain("router-dev-site-a");

        const b = yield* edgeFetch(routerUrl, "/site-b/");
        expect(b.status).toBe(200);
        expect(yield* b.text).toContain("router-dev-site-b");

        // ── The origin received the request CloudFront would have sent ─────
        const echo = yield* edgeFetch(routerUrl, "/site-a/__echo");
        expect(echo.status).toBe(200);
        const echoed = (yield* echo.json) as {
          marker: string;
          path: string;
          headers: Record<string, string>;
        };
        expect(echoed.marker).toBe("site-a");
        expect(echoed.path).toBe("/site-a/__echo");
        // `routeSite` sets x-forwarded-host to the viewer's Host before it
        // rewrites the origin — the site's dev server sees the CloudFront
        // domain there, exactly as a deployed server origin would.
        expect(echoed.headers["x-forwarded-host"]).toBe(
          new URL(routerUrl).host,
        );

        // ── Live edit: the dev server reads from disk per request, so the
        // next edge request serves the new content without re-applying ─────
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(
          path.join(cwdA, "site", "site-a", "index.html"),
          htmlPage("router-dev-site-a-v2"),
        );
        const edited = yield* edgeFetch(routerUrl, "/site-a/");
        expect(yield* edited.text).toContain("router-dev-site-a-v2");

        yield* stack.destroy();
      }),
    { timeout: 300_000 },
  );

  /**
   * The emulated runtime must be at least as restrictive as CloudFront's.
   * CloudFront Functions are not Node: there is no `fetch`. Code that reaches
   * for one has to fail locally, or `alchemy dev` becomes a way to ship
   * broken edge code.
   */
  test.provider(
    "edge code that reaches outside the CloudFront runtime fails locally",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const router = yield* AWS.Website.Router("SandboxRouter", {
              edge: {
                viewerRequest: {
                  injection: `await fetch("https://example.com/");`,
                },
              },
            });
            return { routerUrl: router.url };
          }),
        );

        const response = yield* edgeFetch(
          deployed.routerUrl as string,
          "/anything",
        );
        expect(response.status).toBe(502);
        const body = yield* response.text;
        expect(body).toContain("fetch is not defined");
        expect(body).toContain("not Node.js");

        yield* stack.destroy();
      }),
    { timeout: 180_000 },
  );

  /**
   * `TestFunction` and the edge are backed by the same runtime, so the request
   * object the API reports is the request the origin actually received. That
   * is what makes a local result comparable to the same call against real AWS
   * (which runs the function in AWS's own engine against the DEVELOPMENT
   * stage — seconds, no distribution deploy).
   */
  test.provider(
    "TestFunction agrees with the edge",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const cwd = yield* makeSiteFixture("docs", "router-parity-docs");

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const router = yield* AWS.Website.Router("ParityRouter", {});
            yield* AWS.Website.StaticSite("Docs", {
              path: cwd,
              dev: { command: "bun serve.mjs", env: { DEV_MARKER: "docs" } },
              domain: { router, path: "/docs" },
            });
            return { routerUrl: router.url };
          }),
        );

        const routerUrl = deployed.routerUrl as string;
        const host = new URL(routerUrl).host;

        // What the edge produced, as observed by the origin itself.
        const echo = yield* edgeFetch(routerUrl, "/docs/__echo?q=1");
        const echoed = (yield* echo.json) as {
          path: string;
          headers: Record<string, string>;
        };

        // The same event, through the TestFunction API. The out-of-band SDK
        // calls are pinned to the emulator explicitly — the test process's
        // own distilled clients otherwise point at the real account.
        const result = yield* Effect.gen(function* () {
          const functions = yield* cloudfront.listFunctions({});
          const summary = functions.FunctionList?.Items?.find(
            (item) =>
              item.FunctionConfig.Comment === "ParityRouter viewer request",
          );
          expect(summary).toBeDefined();
          const described = yield* cloudfront.describeFunction({
            Name: summary!.Name,
            Stage: "DEVELOPMENT",
          });
          return yield* cloudfront.testFunction({
            Name: summary!.Name,
            IfMatch: described.ETag!,
            Stage: "DEVELOPMENT",
            EventObject: new TextEncoder().encode(
              JSON.stringify({
                version: "1.0",
                context: { eventType: "viewer-request" },
                viewer: { ip: "127.0.0.1" },
                request: {
                  method: "GET",
                  uri: "/docs/__echo",
                  querystring: { q: { value: "1" } },
                  headers: { host: { value: host } },
                  cookies: {},
                },
              }),
            ),
          });
        }).pipe(Effect.provide(flociServices()));

        expect(result.TestResult?.FunctionErrorMessage).toBeUndefined();
        // `FunctionOutput` is modelled as a sensitive string, so it arrives
        // wrapped — unwrap before parsing.
        const rawOutput = result.TestResult?.FunctionOutput;
        const output = JSON.parse(
          rawOutput === undefined
            ? "{}"
            : typeof rawOutput === "string"
              ? rawOutput
              : Redacted.value(rawOutput),
        ) as { request?: { uri: string; headers: Record<string, any> } };
        expect(output.request?.uri).toBe(echoed.path);
        expect(output.request?.headers["x-forwarded-host"]?.value).toBe(
          echoed.headers["x-forwarded-host"],
        );

        yield* stack.destroy();
      }),
    { timeout: 300_000 },
  );

  /**
   * The oracle for everything above: run the same function through AWS's own
   * engine and compare. `TestFunction` executes against the `DEVELOPMENT`
   * stage, so this costs seconds and never touches a distribution.
   *
   * Gated because it needs real credentials — `AWS_TEST_CLOUDFRONT_FUNCTION=1
   * pnpm test test/AWS/Website/Router.local.test.ts --profile testing`.
   */
  test.provider.skipIf(process.env.AWS_TEST_CLOUDFRONT_FUNCTION !== "1")(
    "the emulated runtime agrees with the real CloudFront runtime",
    () =>
      Effect.gen(function* () {
        const name = "alchemy-cf-runtime-parity";
        const event = new TextEncoder().encode(
          JSON.stringify({
            version: "1.0",
            context: { eventType: "viewer-request" },
            viewer: { ip: "127.0.0.1" },
            request: {
              method: "GET",
              uri: "/docs",
              querystring: { q: { value: "1" } },
              headers: { host: { value: "example.cloudfront.net" } },
              cookies: {},
            },
          }),
        );

        /** Create, test, and delete a function against whichever endpoint is in scope. */
        const runThere = Effect.fn("runThere")(function* (
          suffix: string,
          code: string,
        ) {
          const created = yield* cloudfront.createFunction({
            Name: `${name}-${suffix}`,
            FunctionConfig: { Comment: "parity", Runtime: "cloudfront-js-2.0" },
            FunctionCode: new TextEncoder().encode(code),
          });
          const result = yield* cloudfront.testFunction({
            Name: `${name}-${suffix}`,
            IfMatch: created.ETag!,
            Stage: "DEVELOPMENT",
            EventObject: event,
          });
          yield* cloudfront
            .deleteFunction({
              Name: `${name}-${suffix}`,
              IfMatch: created.ETag!,
            })
            .pipe(Effect.ignore);
          const raw = result.TestResult?.FunctionOutput;
          return {
            error: result.TestResult?.FunctionErrorMessage,
            output:
              raw === undefined
                ? undefined
                : typeof raw === "string"
                  ? raw
                  : Redacted.value(raw),
          };
        });

        // A well-behaved function: both engines must produce the same request.
        const wellBehaved = `async function handler(event) {
  event.request.headers["x-forwarded-host"] = event.request.headers.host;
  event.request.uri = event.request.uri + "/index.html";
  return event.request;
}`;
        const local = yield* runThere("ok", wellBehaved).pipe(
          Effect.provide(flociServices()),
        );
        const real = yield* runThere("ok", wellBehaved);
        expect(local.error).toBeUndefined();
        expect(real.error).toBeUndefined();
        expect(JSON.parse(local.output!)).toEqual(JSON.parse(real.output!));

        // Reaching outside the runtime: both engines must report an error.
        const escaping = `async function handler(event) {
  await fetch("https://example.com/");
  return event.request;
}`;
        const localError = yield* runThere("escape", escaping).pipe(
          Effect.provide(flociServices()),
        );
        const realError = yield* runThere("escape", escaping);
        expect(localError.error).toBeDefined();
        expect(realError.error).toBeDefined();
      }),
    { timeout: 180_000 },
  );
});
