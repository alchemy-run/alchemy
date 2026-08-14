import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as s3 from "@distilled.cloud/aws/s3";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { dockerAvailable } from "../Local/fixtures/raw.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: AWS.providers(), dev: true });

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

describe("AWS.Website.Nextjs local", () => {
  test.provider(
    "dev runs Next's own dev server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        // Clone OUTSIDE the repo (OS temp dir): an in-workspace clone makes
        // OpenNext detect the workspace as a monorepo and trace the server
        // bundle against bun's isolated-install symlink store, which drops
        // transitive deps (e.g. @swc/helpers) from the shipped node_modules.
        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-aws-local-",
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
            });
            return { site };
          }),
        );

        // The site is the framework's own dev server: a localhost URL and
        // no cloud rows at all (proof no AWS call ran).
        const url = deployed.site.url! as string;
        expect(url).toMatch(
          /^http:\/\/(localhost|127\.0\.0\.1|\[[0-9a-fA-F:]+\])/,
        );
        expect(deployed.site.distribution).toBeUndefined();
        expect(deployed.site.server).toBeUndefined();
        expect(deployed.site.bucket).toBeUndefined();
        expect(deployed.site.revalidationQueue).toBeUndefined();
        expect(deployed.site.tagCacheTable).toBeUndefined();

        // SSR page served by the next dev server (native HMR toolchain).
        yield* expectUrlContains(`${url}/`, "NEXTJS_AWS_PAGE_MARKER", {
          timeout: "180 seconds",
          label: "dev SSR home page",
        });
        // App Router API route through the dev server.
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "NEXTJS_AWS_API_MARKER",
          { label: "API route (dev)" },
        );
        yield* expectUrlContains(`${url}/api/hello?echo=dev`, "dev", {
          label: "API route query echo (dev)",
        });

        // ── HMR: edit the App Router route in place. The stack is NOT
        // re-applied — next dev must recompile the route and serve it
        // through the same URL ───────────────────────────────────────────
        const routePath = path.join(rootDir, "app/api/hello/route.ts");
        const route = yield* fs.readFileString(routePath);
        yield* fs.writeFileString(
          routePath,
          route.replace("NEXTJS_AWS_API_MARKER", "NEXTJS_AWS_API_MARKER_V2"),
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "NEXTJS_AWS_API_MARKER_V2",
          { timeout: "120 seconds", label: "API route after HMR edit" },
        );
        // The route still round-trips its query after the recompile.
        yield* expectUrlContains(`${url}/api/hello?echo=post-hmr`, "post-hmr", {
          label: "API route query echo after HMR edit",
        });

        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );
});

// ─────────────────────────────────────────────────────────────────────
// Effectful Next.js (zero-setup, DESIGN §7-AWS): NO user mount file. The
// dev `Server` runs the alchemy-owned custom-server child (`next dev`
// through the programmatic API) with the Serve bridge dispatching
// `/api/__rpc` + `server.routes` BEFORE Next's handler — the same
// rpc-first + strict-ownership gate as the deployed wrapper. Env is
// lowered by the composite (stack markers + packed binding values +
// AWS_REGION), credentials resolve from the developer's ambient profile
// (the AWS dev model: bindings hit real cloud, so the bound bucket is
// `remote()`), and the effect program also deploys into the floci Lambda
// emulator as the dev server Lambda. Editing the backend module mid-run
// hot-swaps the effect handlers in the child (watch + cache-busted
// re-import). Docker required (floci); live credentials required
// (--profile testing).
// ─────────────────────────────────────────────────────────────────────

// Clone INSIDE the workspace (unlike the plain dev test above, which
// clones to the OS temp dir for OpenNext's monorepo detection — no
// OpenNext build runs in dev): the generated site module and route mount
// import `packages/alchemy/src` by relative path, so the current sources
// (not a stale built `lib/`) are compiled by Next in the dev server and
// imported by bun in the plan world.
const inWorkspaceTempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");
const alchemySrcFrom = (relDepth: number) => `${"../".repeat(relDepth)}src`;

/**
 * The effectful site module written into the clone at `src/site.ts`
 * (clone sits at `packages/alchemy/.tmp/<dir>/`, so `../../../src` is
 * `packages/alchemy/src`). Parameterized by `marker` so the effect-HMR
 * case can rewrite it mid-test and observe the hot-swapped handlers —
 * both the effect `fetch` and the `stamp` RPC method surface it.
 *
 * `server.routes` claims only `/api/effect/*` (strict ownership inside
 * the claim), so the fixture's own Next route at `/api/hello` stays
 * outside the claim and behaves identically in dev and deploy — the §5
 * route-precedence parity pin.
 */
const nextEffectSiteSource = (marker: string) => `
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as NodePath from "node:path";
import { Bucket } from "${alchemySrcFrom(3)}/AWS/S3/Bucket.ts";
import { GetObject } from "${alchemySrcFrom(3)}/AWS/S3/GetObject.ts";
import { GetObjectHttp } from "${alchemySrcFrom(3)}/AWS/S3/GetObjectHttp.ts";
import { PutObject } from "${alchemySrcFrom(3)}/AWS/S3/PutObject.ts";
import { PutObjectHttp } from "${alchemySrcFrom(3)}/AWS/S3/PutObjectHttp.ts";
import { Nextjs } from "${alchemySrcFrom(3)}/AWS/Website/Nextjs.ts";
import { remote } from "${alchemySrcFrom(3)}/ProviderMode.ts";

const MARKER = "${marker}";

/**
 * S3 bucket bound by the effectful site's program. \`remote()\`: the AWS
 * dev model — capability bindings hit the REAL cloud with ambient
 * credentials, so the bound bucket opts out of local emulation.
 */
export const SiteData = Bucket("NextEffectLocalData", {
  forceDestroy: true,
}).pipe(remote());

export default class NextEffectSite extends Nextjs<NextEffectSite>()(
  "NextEffectSite",
  {
    main: import.meta.url,
    // Plan-only (guarded: undefined when the module re-evaluates inside a
    // deployed bundle where import.meta has no path).
    rootDir: import.meta.dirname
      ? NodePath.dirname(import.meta.dirname)
      : undefined,
    server: { routes: ["/api/effect/*"] },
  },
  Effect.gen(function* () {
    const bucket = yield* SiteData;
    const putObject = yield* PutObject(bucket);
    const getObject = yield* GetObject(bucket);
    return {
      stamp: () => Effect.succeed({ marker: MARKER }),
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://fixture");
        if (url.pathname === "/api/effect/ping") {
          return yield* HttpServerResponse.json({ marker: MARKER });
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

/** POST `/api/__rpc/<method>` (empty args) until it answers 200 JSON. */
const rpcCallReady = <T>(base: string, method: string, times = 30) =>
  Effect.gen(function* () {
    return yield* HttpClient.execute(
      HttpClientRequest.post(`${base}/api/__rpc/${method}`).pipe(
        HttpClientRequest.bodyText("[]", "application/json"),
      ),
    ).pipe(
      Effect.flatMap((res) =>
        Effect.flatMap(res.text, (body) =>
          res.status === 200
            ? Effect.try({
                try: () => JSON.parse(body) as { value: T },
                catch: () =>
                  new Error(`non-json rpc body: ${body.slice(0, 300)}`),
              })
            : Effect.fail(
                new Error(
                  `rpc not ready (${res.status}): ${body.slice(0, 300)}`,
                ),
              ),
        ),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times }),
    );
  });

/** GET `url` until it answers 200 JSON — bounded (first hit compiles the
 * route + the alchemy graph under turbopack, be patient). */
const fetchJsonReady = <T>(url: string, times = 60) =>
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

describe("AWS.Website.Nextjs local (effectful)", () => {
  test.provider.skipIf(!dockerAvailable)(
    "effectful Next.js dev (zero-setup): front dispatch serves /api/effect/* + rpc with the real S3 binding, no mount file",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* stack.destroy();
        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-aws-effect-dev-",
          tempRoot: inWorkspaceTempRoot,
          entries: fixtureEntries,
        });
        // Hoisted install in the clone: `next dev` requires a project-local
        // `typescript` (the fixture has tsconfig.json + TS route files) —
        // without it the boot BLOCKS on Next's install-TypeScript flow and
        // the dev server never binds its port.
        yield* run({
          cmd: "bun",
          args: ["install", "--linker=hoisted"],
          cwd: rootDir,
        });

        // ZERO-SETUP: only the site module is written — no route mount,
        // no generated file in the user's `app/` tree. The dev child's
        // front dispatch delivers the effect routes.
        yield* fs.makeDirectory(path.join(rootDir, "src"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(rootDir, "src", "site.ts"),
          nextEffectSiteSource("effect-fetch-v1"),
        );

        // Bun resolves the clone's relative imports to the same
        // `packages/alchemy/src` modules as `@/...`.
        const mod = (yield* Effect.tryPromise(
          () =>
            import(pathToFileURL(path.join(rootDir, "src", "site.ts")).href),
        )) as {
          default: any;
          SiteData: Effect.Effect<AWS.S3.Bucket, never, any>;
        };
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            // The impl's `yield* SiteData` registers the bucket at the
            // caller's namespace (registration is idempotent per FQN) —
            // this resolves the SAME row the binding uses.
            const data = yield* mod.SiteData;
            const site = yield* mod.default;
            return { data, site };
          }),
        );

        // The site is `next dev`; no CDN resources exist; the effect
        // program deployed into the floci Lambda emulator (dummy-account
        // ARN — proof no real cloud call ran for it).
        const url = deployed.site.url! as string;
        expect(url).toMatch(
          /^http:\/\/(localhost|127\.0\.0\.1|\[[0-9a-fA-F:]+\])/,
        );
        expect(deployed.site.distribution).toBeUndefined();
        expect(deployed.site.bucket).toBeUndefined();
        expect(deployed.site.server).toBeDefined();
        expect(deployed.site.server!.functionArn).toContain(":000000000000:");
        // The remote() bucket is REAL — a live-cloud ARN, not the
        // emulator's dummy account.
        expect(deployed.data.bucketArn).not.toContain(":000000000000:");

        // The framework page proves next dev serves.
        yield* expectUrlContains(`${url}/`, "NEXTJS_AWS_PAGE_MARKER", {
          timeout: "240 seconds",
          label: "effectful dev SSR home page",
        });
        // Next's own API route OUTSIDE the claim (`routes:
        // ["/api/effect/*"]`) still answers — route-precedence parity
        // with the deployed wrapper: outside the claim the framework
        // serves, in dev exactly as on deploy.
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "NEXTJS_AWS_API_MARKER",
          { label: "framework API route untouched" },
        );

        // Effect route through the front dispatch — no mount file exists.
        const ping = yield* fetchJsonReady<{ marker: string }>(
          `${url}/api/effect/ping`,
        );
        expect(ping.marker).toBe("effect-fetch-v1");

        // Strict ownership inside the claim: an unknown path is the
        // effect's OWN 404 (the fixture's JSON), never Next's HTML 404 —
        // the dispatch answered before Next's router ever ran.
        const client = yield* HttpClient.HttpClient;
        const missing = yield* client.get(`${url}/api/effect/nope`);
        expect(missing.status).toBe(404);
        const missingBody = yield* missing.text;
        expect(missingBody).not.toContain("<html");
        expect(JSON.parse(missingBody)).toEqual({
          error: "unknown effect route",
        });

        // The universal RPC dispatch (`POST /api/__rpc/<method>`) needs no
        // routes claim and no mount either.
        const stamped = yield* rpcCallReady<{ marker: string }>(url, "stamp");
        expect(stamped.value.marker).toBe("effect-fetch-v1");

        // S3 round-trip through the binding: the mount's capability
        // clients resolve ambient credentials (`Credentials.fromChain()`)
        // against the REAL remote() bucket. Random payload so a stale
        // object can never satisfy the read.
        const value = `nextjs-aws-effect-${crypto.randomUUID()}`;
        const written = yield* fetchJsonReady<{ value: string | undefined }>(
          `${url}/api/effect/s3?key=greeting&put=${value}`,
        );
        expect(written.value).toBe(value);
        const read = yield* fetchJsonReady<{ value: string | undefined }>(
          `${url}/api/effect/s3?key=greeting`,
        );
        expect(read.value).toBe(value);

        // Out-of-band: the write is visible through the cloud S3 API —
        // the dev binding really hit the live bucket.
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
              times: 5,
            }),
          );
        expect(observed).toBe(value);

        // ── Effect-handler HMR: rewrite the backend module in place. The
        // stack is NOT re-applied — the dev child's watcher re-imports the
        // module (cache-busted → fresh class identity → fresh layer build)
        // and the next dispatch serves the new marker. Bounded poll ──────
        yield* fs.writeFileString(
          path.join(rootDir, "src", "site.ts"),
          nextEffectSiteSource("effect-fetch-v2"),
        );
        const swapped = yield* fetchJsonReady<{ marker: string }>(
          `${url}/api/effect/ping`,
        ).pipe(
          Effect.repeat({
            until: (body): boolean => body.marker === "effect-fetch-v2",
            schedule: Schedule.spaced("2 seconds"),
            times: 30,
          }),
        );
        expect(swapped.marker).toBe("effect-fetch-v2");
        // The RPC surface hot-swapped with the same generation.
        const restamped = yield* rpcCallReady<{ marker: string }>(url, "stamp");
        expect(restamped.value.marker).toBe("effect-fetch-v2");
        // The S3 binding survived the swap (env-packed values re-resolve
        // against the same lowered process env).
        const reread = yield* fetchJsonReady<{ value: string | undefined }>(
          `${url}/api/effect/s3?key=greeting`,
        );
        expect(reread.value).toBe(value);

        yield* stack.destroy();

        // The remote() bucket's state row is stamped live, so the live
        // provider deleted it from the cloud even in a dev run.
        const gone = yield* s3
          .headBucket({ Bucket: deployed.data.bucketName as string })
          .pipe(
            Effect.as(false),
            Effect.catchTag(["NotFound", "NoSuchBucket"], () =>
              Effect.succeed(true),
            ),
            Effect.repeat({
              until: (deleted): boolean => deleted,
              schedule: Schedule.spaced("3 seconds"),
              times: 10,
            }),
          );
        expect(gone).toBe(true);
      }),
    { timeout: 600_000 },
  );
});
