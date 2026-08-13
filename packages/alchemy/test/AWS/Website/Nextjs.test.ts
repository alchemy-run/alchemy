import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as s3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Gated with the rest of the AWS.Website suites: the OpenNext build plus the
// CloudFront lifecycle dominate the runtime (create ~10-20 min, destroy
// ~5-15 min).
const runLive = process.env.ALCHEMY_RUN_LIVE_AWS_WEBSITE_TESTS === "true";

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nextjs-app");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "next.config.ts",
  "tsconfig.json",
  "app",
  "public",
];

/**
 * Run a command to completion in a child process (Effect-wrapped spawn —
 * the suite shares one bun process, so a sync spawn would stall every
 * concurrently running test). Fails with the combined output on a
 * non-zero exit.
 */
const run = (options: {
  cmd: string;
  args: string[];
  cwd: string;
}): Effect.Effect<string, Error> =>
  Effect.callback<string, Error>((resume) => {
    const child = spawn(options.cmd, options.args, {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("error", (error) => resume(Effect.fail(error)));
    child.once("close", (code) =>
      resume(
        code === 0
          ? Effect.succeed(output)
          : Effect.fail(
              new Error(
                `${options.cmd} ${options.args.join(" ")} exited ${code}:\n${output}`,
              ),
            ),
      ),
    );
    return Effect.sync(() => child.kill("SIGKILL"));
  });

describe.skipIf(!runLive)("AWS.Website.Nextjs", () => {
  test.provider(
    "deploys the OpenNext topology: streaming SSR Lambda, S3 assets, image optimizer, ISR wiring",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Clone OUTSIDE the repo (OS temp dir): an in-workspace clone makes
        // OpenNext detect the workspace as a monorepo and trace the server
        // bundle against bun's isolated-install symlink store, which drops
        // transitive deps (e.g. @swc/helpers) from the shipped node_modules.
        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-aws-",
          entries: fixtureEntries,
        });
        // Hoisted install in the clone so output tracing sees a plain
        // node_modules tree — the representative user-project shape.
        yield* run({
          cmd: "bun",
          args: ["install", "--linker=hoisted"],
          cwd: rootDir,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.Nextjs("NextjsSite", {
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
        expect(deployed.site.imageUrl).toBeDefined();
        expect(deployed.site.revalidationQueue).toBeDefined();
        expect(deployed.site.tagCacheTable).toBeDefined();
        yield* Effect.log(
          `site url: ${url} | server url: ${deployed.site.serverUrl}`,
        );

        // The Lambda Function URL serves the SSR page directly — isolates
        // server-function health from the CloudFront edge routing.
        yield* expectUrlContains(
          `${deployed.site.serverUrl!}`,
          "NEXTJS_AWS_PAGE_MARKER",
          {
            timeout: "120 seconds",
            label: "SSR direct from Lambda URL",
          },
        );

        // SSR page rendered by the Lambda through CloudFront.
        yield* expectUrlContains(`${url}/`, "NEXTJS_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "SSR home page",
        });
        // App Router API route through the streaming Function URL origin.
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "NEXTJS_AWS_API_MARKER",
          { label: "API route" },
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "roundtrip",
          { label: "API route query echo" },
        );
        // Statically-rendered page: prerendered into the ISR cache at build
        // time, served by the server function through the S3 incremental
        // cache — proves the cache seed upload and the cache-bucket IAM.
        yield* expectUrlContains(`${url}/static`, "NEXTJS_AWS_STATIC_MARKER", {
          label: "static (prerendered) page",
        });
        // Public file served from S3 via the KV file manifest.
        yield* expectUrlContains(
          `${url}/robots.txt`,
          "nextjs-aws-robots-marker",
          {
            label: "public asset from S3",
          },
        );
        // Client asset (hashed chunk) served from S3: the SSR page links
        // /_next/static/* files uploaded by the asset deployment.
        expect(deployed.site.files?.files).toBeDefined();

        // Image optimization: /_next/image is routed by the edge function
        // to the dedicated optimizer Lambda, which loads the original from
        // the asset bucket and returns an optimized image.
        const client = yield* HttpClient.HttpClient;
        const imageUrl = `${url}/_next/image?url=%2Fpixel.png&w=64&q=75`;
        const imageResponse = yield* client.get(imageUrl).pipe(
          Effect.filterOrFail(
            (response): boolean => response.status === 200,
            (response) =>
              new Error(`/_next/image returned status ${response.status}`),
          ),
          Effect.retry({
            schedule: Schedule.exponential("2 seconds"),
            times: 8,
          }),
        );
        expect(imageResponse.status).toBe(200);
        expect(imageResponse.headers["content-type"] ?? "").toMatch(/^image\//);

        const distributionId = deployed.site.distribution!.distributionId;

        if (!process.env.NO_DESTROY) {
          yield* stack.destroy();
          yield* assertDistributionDeleted(distributionId);
        }
      }),
    { timeout: 2_400_000 },
  );
});

// ─────────────────────────────────────────────────────────────────────
// Effectful Next.js live (explicit tier, DESIGN §7-AWS): the Effect
// program rides the `toRouteHandler` catch-all route compiled by Next into
// the OpenNext server function (collect-only mode — the artifact ships
// as-is; the deploy-time sentinel scan proves the mount), and the edge
// serverRoutes check forwards /api/* to the server BEFORE the manifest.
//
// The clone lives OUTSIDE the workspace (OpenNext monorepo detection), so
// `alchemy`/`effect` are symlinked into the clone post-install (the
// `bun link` topology) — the site module imports the PACKAGE surface, which
// resolves through the `import` condition to the built `lib/`. The gated
// live suite runs at wave gates, after the coordinator's `bun tsc -b` has
// rebuilt `lib/` — a stale lib would miss the effectful construct arms.
// ─────────────────────────────────────────────────────────────────────

const workspaceRoot = pathe.resolve(import.meta.dirname, "../../../../..");

/** The live effectful site module (written into the clone at `src/site.ts`). */
const nextEffectLiveSiteSource = `
import { Bucket, GetObject, GetObjectHttp, PutObject, PutObjectHttp } from "alchemy/AWS/S3";
import { Nextjs } from "alchemy/AWS/Website";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as NodePath from "node:path";

/** S3 bucket bound by the effectful site's program. */
export const SiteData = Bucket("NextEffectLiveData", { forceDestroy: true });

export default class NextEffectLiveSite extends Nextjs<NextEffectLiveSite>()(
  "NextEffectSite",
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
    const putObject = yield* PutObject(bucket);
    const getObject = yield* GetObject(bucket);
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
        return yield* HttpServerResponse.json(
          { error: "unknown effect route" },
          { status: 404 },
        );
      }),
    };
  }).pipe(Effect.provide([PutObjectHttp, GetObjectHttp])),
) {}
`;

/** The explicit-tier mount (`app/api/effect/[[...slug]]/route.ts`). */
const nextLiveRouteMountSource = [
  `import { toRouteHandler } from "alchemy/serve/next";`,
  `import Site from "../../../../src/site";`,
  `const handler = toRouteHandler(Site);`,
  `export { handler as GET, handler as POST, handler as PUT,`,
  `         handler as PATCH, handler as DELETE, handler as HEAD,`,
  `         handler as OPTIONS };`,
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

describe.skipIf(!runLive)("AWS.Website.Nextjs (effectful)", () => {
  test.provider(
    "effectful site: toRouteHandler mount serves /api/effect/* through CloudFront with the S3 binding",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-aws-effect-",
          entries: fixtureEntries,
        });

        // Link this workspace's alchemy + effect into the clone so Next
        // compiles the site module and the serve mount from the package
        // surface (App Router bundles dependencies into the server chunk).
        const packageJsonPath = path.join(rootDir, "package.json");
        const packageJson = JSON.parse(
          yield* fs.readFileString(packageJsonPath),
        ) as { dependencies?: Record<string, string> };
        yield* fs.writeFileString(
          packageJsonPath,
          `${JSON.stringify(packageJson, null, 2)}\n`,
        );
        yield* run({
          cmd: "bun",
          args: ["install", "--linker=hoisted"],
          cwd: rootDir,
        });
        // Symlink this workspace's alchemy + effect into the clone (what
        // `bun link` produces). A `link:`/`file:` dependency cannot work
        // here: `link:` needs the global link registry, and `file:` copies
        // alchemy's package.json whose `workspace:*` deps only resolve
        // inside the workspace. A plain symlink resolves the package
        // surface through its realpath, so alchemy's own dependencies come
        // from the workspace root as usual.
        const cloneModules = path.join(rootDir, "node_modules");
        const effectRealpath = yield* fs.realPath(
          pathe.join(workspaceRoot, "node_modules", "effect"),
        );
        for (const [name, target] of [
          ["alchemy", pathe.join(workspaceRoot, "packages", "alchemy")],
          // Realpath, not the workspace symlink: turbopack refuses to
          // resolve a symlink chain (link -> workspace link -> .bun store).
          ["effect", effectRealpath],
        ] as const) {
          const linkPath = path.join(cloneModules, name);
          yield* fs.remove(linkPath, { recursive: true }).pipe(Effect.ignore);
          yield* fs.symlink(target, linkPath);
        }
        // Build with webpack: Turbopack refuses to resolve the symlinked
        // packages outside its root (which OpenNext pins to the app dir via
        // outputFileTracingRoot), while webpack follows them to their
        // realpaths. Same default config alchemy generates, plus the
        // buildCommand override.
        yield* fs.writeFileString(
          path.join(rootDir, "open-next.config.ts"),
          [
            `const config = {`,
            `  default: {`,
            `    override: {`,
            `      wrapper: "aws-lambda-streaming",`,
            `    },`,
            `  },`,
            `  buildCommand: "npx next build --webpack",`,
            `};`,
            ``,
            `export default config;`,
            ``,
          ].join("\n"),
        );

        // Write the site module + the explicit route mount into the clone.
        yield* fs.makeDirectory(path.join(rootDir, "src"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(rootDir, "src", "site.ts"),
          nextEffectLiveSiteSource,
        );
        const routeDir = path.join(
          rootDir,
          "app",
          "api",
          "effect",
          "[[...slug]]",
        );
        yield* fs.makeDirectory(routeDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(routeDir, "route.ts"),
          nextLiveRouteMountSource,
        );

        const mod = (yield* Effect.tryPromise(
          () =>
            import(pathToFileURL(path.join(rootDir, "src", "site.ts")).href),
        )) as {
          default: any;
          SiteData: Effect.Effect<AWS.S3.Bucket, never, any>;
        };

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const data = yield* mod.SiteData;
            const site = yield* mod.default;
            return { data, site };
          }),
        );

        const url = deployed.site.url! as string;
        expect(url).toMatch(/^https:\/\//);
        yield* Effect.log(
          `site url: ${url} | server url: ${deployed.site.serverUrl}`,
        );

        // SSR still serves (the collect-only OpenNext artifact shipped
        // as-is).
        yield* expectUrlContains(`${url}/`, "NEXTJS_AWS_PAGE_MARKER", {
          timeout: "300 seconds",
          label: "SSR home page (effectful)",
        });
        // Next's own API route INSIDE /api/* still answers — the effect
        // mount owns only /api/effect/*.
        yield* expectUrlContains(
          `${url}/api/hello?echo=roundtrip`,
          "NEXTJS_AWS_API_MARKER",
          { label: "framework API route untouched" },
        );

        // Effect fetch through CloudFront (edge serverRoutes → server
        // Lambda → Next router → catch-all mount).
        const ping = yield* fetchJsonReady<{ marker: string }>(
          `${url}/api/effect/ping`,
        );
        expect(ping.marker).toBe("effect-fetch");

        // S3 round-trip through the binding collected onto the server
        // Lambda (env + IAM). Random payload defeats stale objects.
        const value = `nextjs-aws-effect-live-${crypto.randomUUID()}`;
        const written = yield* fetchJsonReady<{ value: string | undefined }>(
          `${url}/api/effect/s3?key=greeting&put=${value}`,
        );
        expect(written.value).toBe(value);
        const read = yield* fetchJsonReady<{ value: string | undefined }>(
          `${url}/api/effect/s3?key=greeting`,
        );
        expect(read.value).toBe(value);

        // Out-of-band: the write landed in the real bucket — the binding's
        // env + IAM reached the OpenNext server Lambda.
        const observed = yield* s3
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
        expect(observed).toBe(value);

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
