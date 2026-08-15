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
import { pathToFileURL } from "node:url";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { dockerAvailable } from "../Local/fixtures/raw.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: AWS.providers(), dev: true });

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

describe("AWS.Website.Nuxt local", () => {
  test.provider(
    "dev runs Nuxt's own dev server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-aws-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.Nuxt("NuxtSite", {
              rootDir,
              server: {
                environment: {
                  NUXT_PUBLIC_ENV_MARKER: "nuxt-aws-dev-env-marker",
                },
              },
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

        // SSR page served by the nuxt dev server (native HMR toolchain).
        yield* expectUrlContains(`${url}/`, "NUXT_AWS_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "dev SSR home page",
        });
        // The fixture's own nuxt.config.ts applied in dev too.
        yield* expectUrlContains(
          `${url}/`,
          "config:nuxt-aws-user-config-loaded",
          { label: "user nuxt.config.ts applied (dev)" },
        );
        // server.environment reaches the dev server's process env — the
        // same values the Lambda gets on deploy (dev/live parity).
        yield* expectUrlContains(`${url}/`, "env:nuxt-aws-dev-env-marker", {
          label: "server.environment injected into dev server",
        });
        // Server API route through the dev server.
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "NUXT_AWS_API_MARKER",
          { label: "API route (dev)" },
        );

        // ── HMR: edit the API route in place. The stack is NOT re-applied —
        // nitro's dev rebuild must pick the change up and serve it through
        // the same URL ───────────────────────────────────────────────────
        const helloPath = path.join(rootDir, "server/api/hello.ts");
        const hello = yield* fs.readFileString(helloPath);
        yield* fs.writeFileString(
          helloPath,
          hello.replace("NUXT_AWS_API_MARKER", "NUXT_AWS_API_MARKER_V2"),
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "NUXT_AWS_API_MARKER_V2",
          { timeout: "90 seconds", label: "API route after HMR edit" },
        );
        // server.environment survived the dev rebuild — the injected env
        // still reaches SSR after the reload (dev/live parity holds across
        // hot updates, not just at boot).
        yield* expectUrlContains(`${url}/`, "env:nuxt-aws-dev-env-marker", {
          label: "server.environment after HMR edit",
        });

        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );
});

// ─────────────────────────────────────────────────────────────────────
// Effectful Nuxt (zero-setup wrapper tier, DESIGN §7-AWS): NO user mount
// file — the framework integration writes the generated effect middleware
// under `<root>/.alchemy/nuxt/<id>/` and injects it through
// `nitro.handlers`, so nitro compiles it into the dev worker exactly as it
// would a scanned `server/middleware/*` file. Env lowered by the composite
// (stack markers + packed binding values + AWS_REGION), credentials
// resolved from the developer's ambient profile (the AWS dev model:
// bindings hit real cloud, so the bound bucket is `remote()`) — while the
// effect program also deploys into the floci Lambda emulator as the dev
// server Lambda. Docker required (floci); live credentials required
// (--profile testing).
// ─────────────────────────────────────────────────────────────────────

/**
 * The effectful site module written into the clone at `src/site.ts`
 * (clone sits at `packages/alchemy/.tmp/<dir>/`, so `../../../src` is
 * `packages/alchemy/src` — the CURRENT sources, not a stale built `lib/`).
 */
const nuxtEffectSiteSource = `
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as NodePath from "node:path";
import { Bucket } from "../../../src/AWS/S3/Bucket.ts";
import { GetObject } from "../../../src/AWS/S3/GetObject.ts";
import { GetObjectHttp } from "../../../src/AWS/S3/GetObjectHttp.ts";
import { PutObject } from "../../../src/AWS/S3/PutObject.ts";
import { PutObjectHttp } from "../../../src/AWS/S3/PutObjectHttp.ts";
import { Nuxt } from "../../../src/AWS/Website/Nuxt.ts";
import { remote } from "../../../src/ProviderMode.ts";

/**
 * S3 bucket bound by the effectful site's program. \`remote()\`: the AWS
 * dev model — capability bindings hit the REAL cloud with ambient
 * credentials, so the bound bucket opts out of local emulation.
 */
export const SiteData = Bucket("NuxtEffectLocalData", {
  forceDestroy: true,
}).pipe(remote());

export default class NuxtEffectSite extends Nuxt<NuxtEffectSite>()(
  "NuxtEffectSite",
  {
    main: import.meta.url,
    // Narrow claim: /api/hello (nitro's own route) sits OUTSIDE it.
    server: { routes: ["/api/effect/*"] },
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
        // Unknown path INSIDE the claim: the effect fetch is authoritative
        // here, so this is its OWN 404 — never delegation to nitro (paths
        // outside the middleware's routes never reach this fetch at all).
        return HttpServerResponse.json(
          { marker: "effect-404" },
          { status: 404 },
        );
      }),
    };
  }).pipe(Effect.provide([PutObjectHttp, GetObjectHttp])),
) {}
`;

/** GET `url` until it answers 200 JSON — bounded (the first hit boots the
 * dev worker bundle including the alchemy graph, be patient). */
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

describe("AWS.Website.Nuxt local (effectful)", () => {
  test.provider.skipIf(!dockerAvailable)(
    "effectful Nuxt dev: the injected middleware serves /api/effect/* with NO mount file",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-aws-effect-dev-",
          tempRoot,
          entries: fixtureEntries,
        });

        // Write the site module into the clone. NO mount file: the
        // framework integration generates the middleware itself and
        // injects it via `nitro.handlers` (zero-setup delivery).
        yield* fs.makeDirectory(path.join(rootDir, "src"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(rootDir, "src", "site.ts"),
          nuxtEffectSiteSource,
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
            const data = yield* mod.SiteData;
            const site = yield* mod.default;
            return { data, site };
          }),
        );

        // The site is `nuxt dev`; no CDN resources; the effect program
        // deployed into the floci Lambda emulator (dummy-account ARN).
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

        // The generated middleware exists under the clone's `.alchemy/`
        // (the ONLY generated artifact — nothing in the user's server/
        // tree).
        const generatedHandler = path.join(
          rootDir,
          ".alchemy",
          "nuxt",
          "NuxtEffectSite",
          "effect-handler.mjs",
        );
        expect(yield* fs.exists(generatedHandler)).toBe(true);
        expect(
          yield* fs.exists(
            path.join(rootDir, "server", "middleware", "alchemy.ts"),
          ),
        ).toBe(false);

        // The framework page proves nuxt dev serves (middleware passes /
        // through).
        yield* expectUrlContains(`${url}/`, "NUXT_AWS_PAGE_MARKER", {
          timeout: "240 seconds",
          label: "effectful dev SSR home page",
        });
        // Nitro's own API route sits OUTSIDE the effect claim
        // (`/api/effect/*`) — the injected middleware declines the path
        // and nitro's handler answers.
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "NUXT_AWS_API_MARKER",
          { label: "path outside the claim routes to nitro" },
        );

        // Effect route through the injected middleware.
        const ping = yield* fetchJsonReady<{ marker: string }>(
          `${url}/api/effect/ping`,
        );
        expect(ping.marker).toBe("effect-fetch");

        // An unknown route INSIDE the claim is the effect's own 404 — the
        // fetch's marker body proves WHO answered (never nitro's 404).
        const insideMiss = yield* Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const res = yield* client.get(
            `${url}/api/effect/definitely-not-here`,
          );
          return { status: res.status, body: yield* res.text };
        });
        expect(insideMiss.status).toBe(404);
        expect(insideMiss.body).toContain("effect-404");

        // S3 round-trip through the binding: the mount's capability
        // clients resolve ambient credentials (`Credentials.fromChain()`)
        // against the REAL remote() bucket. Random payload so a stale
        // object can never satisfy the read.
        const value = `nuxt-aws-effect-${crypto.randomUUID()}`;
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
