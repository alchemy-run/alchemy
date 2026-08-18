import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { Region } from "@distilled.cloud/aws/Region";
import * as S3 from "@distilled.cloud/aws/s3";
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

describe("AWS.Website.SvelteKit local", () => {
  test.provider(
    "dev runs SvelteKit's own dev server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-sveltekit-aws-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.SvelteKit("SvelteKitSite", {
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

        // SSR page served by the kit dev server (native HMR toolchain).
        yield* expectUrlContains(`${url}/`, "SVELTEKIT_AWS_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "dev SSR home page",
        });
        // Server API route through the dev server.
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "SVELTEKIT_AWS_API_MARKER",
          { label: "API route (dev)" },
        );
        yield* expectUrlContains(`${url}/api/hello?echo=dev`, "dev", {
          label: "API route query echo (dev)",
        });

        // ── HMR: edit the API route in place. The stack is NOT re-applied —
        // the kit/vite dev rebuild must pick the change up and serve it
        // through the same URL ───────────────────────────────────────────
        const helloPath = path.join(rootDir, "src/routes/api/hello/+server.ts");
        const hello = yield* fs.readFileString(helloPath);
        yield* fs.writeFileString(
          helloPath,
          hello.replace(
            "SVELTEKIT_AWS_API_MARKER",
            "SVELTEKIT_AWS_API_MARKER_V2",
          ),
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "SVELTEKIT_AWS_API_MARKER_V2",
          { timeout: "90 seconds", label: "API route after HMR edit" },
        );
        // The route still round-trips its query after the reload.
        yield* expectUrlContains(`${url}/api/hello?echo=post-hmr`, "post-hmr", {
          label: "API route query echo after HMR edit",
        });

        yield* stack.destroy();
      }),
    { timeout: 600_000 },
  );
});

// ─────────────────────────────────────────────────────────────────────
// Effectful SvelteKit under `alchemy dev` (the mount design,
// Serve/DESIGN.md): the fixture's `src/hooks.server.ts` mount serves the
// effect API natively inside kit's Vite dev server, running in the
// RPC-sidecar process with env lowered by the composite. Bindings hit
// the REAL cloud with ambient credentials (the AWS dev model — no local
// S3 emulator), while the effect program also deploys into the floci
// Lambda emulator as the dev server Lambda (docker required).
// ─────────────────────────────────────────────────────────────────────

const effectFixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "sveltekit-effect-app",
);

/** GET a JSON body, retrying until the dev server + layer build settle. */
const fetchJsonReady = <T>(url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.flatMap(res.text, (body) =>
              Effect.try({
                try: () => JSON.parse(body) as T,
                catch: () => new Error(`non-json body: ${body}`),
              }),
            )
          : Effect.fail(new Error(`dev server not ready: ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("4 seconds"),
        ]),
        times: 15,
      }),
    );
  });

describe("AWS.Website.SvelteKit local (effectful)", () => {
  test.provider.skipIf(!dockerAvailable)(
    "effectful SvelteKit dev: /api/* serves through the hooks mount with real S3; the exclusion glob, SSR, and streamed bodies work",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(effectFixtureDir, {
          prefix: "alchemy-sveltekit-aws-effect-dev-",
          tempRoot,
          entries: ["package.json", "src"],
        });

        // The site module is cloned with the fixture, so it is imported
        // dynamically from the clone (its `rootDir` prop derives from its
        // own location). Bun resolves `alchemy/...` through the workspace
        // symlink to the same module instances as `@/...`.
        const siteModule = (yield* Effect.tryPromise(
          () =>
            import(pathToFileURL(pathe.join(rootDir, "src", "site.ts")).href),
        )) as typeof import("./fixtures/sveltekit-effect-app/src/site.ts");

        const { site, data } = yield* stack.deploy(
          Effect.gen(function* () {
            // The impl's `yield* SiteData` registers the bucket at the
            // root (registration is idempotent per FQN) — this resolves
            // the SAME row the binding uses.
            const data = yield* siteModule.SiteData;
            const site = yield* siteModule.default;
            return { data, site };
          }),
        );

        // The site's url is kit's own Vite dev server; no CDN resources
        // exist. The `remote()` S3 bucket is REAL (the AWS dev model —
        // bindings hit real cloud), while the effect sibling Lambda runs
        // in the floci emulator (dummy-account ARN).
        const url = site.url! as string;
        expect(url).toMatch(
          /^http:\/\/(localhost|127\.0\.0\.1|\[[0-9a-fA-F:]+\])/,
        );
        expect(site.distribution).toBeUndefined();
        expect(site.bucket).toBeUndefined();
        expect(site.files).toBeUndefined();
        expect(site.server.functionArn).toContain(":000000000000:");
        expect(data.bucketArn).not.toContain(":000000000000:");

        // ── Effect surface: /api/effect/s3 write+read round-trips the S3
        // capability bindings through the hooks mount, against the REAL
        // bucket with ambient credentials. Random payload so a stale
        // object from an earlier run can never satisfy the read ──────────
        const s3Value = `sveltekit-aws-effect-${crypto.randomUUID()}`;
        const s3Write = yield* fetchJsonReady<{ value: string | undefined }>(
          `${url}/api/effect/s3?key=greeting&put=${s3Value}`,
        );
        expect(s3Write.value).toBe(s3Value);
        const s3Read = yield* fetchJsonReady<{ value: string | undefined }>(
          `${url}/api/effect/s3?key=greeting`,
        );
        expect(s3Read.value).toBe(s3Value);

        // Out-of-band: the write is visible through the cloud API — the
        // dev binding really hit the live bucket. Pinned to the bucket's
        // own region: the harness context may resolve a different default
        // region than the provider that created the bucket.
        const inBucketRegion = Effect.provideService(
          Region,
          Effect.succeed(data.region),
        );
        const cloudBody = yield* S3.getObject({
          Bucket: data.bucketName,
          Key: "greeting",
        }).pipe(
          Effect.flatMap((res) =>
            Stream.mkString(Stream.decodeText(res.Body!)),
          ),
          Effect.retry({
            schedule: Schedule.exponential("1 second", 1.5),
            times: 5,
          }),
          inBucketRegion,
        );
        expect(cloudBody).toBe(s3Value);

        // ── Streamed effect response through the hooks mount ─────────────
        yield* expectUrlContains(
          `${url}/api/effect/stream`,
          siteModule.STREAM_MARKER,
          { timeout: "60 seconds", label: "streamed effect response (dev)" },
        );

        // ── Exclusion glob: /api/hello is carved OUT of the mount's claim
        // (`!/api/hello`), so the mount declines the path and kit's own
        // +server endpoint answers ───────────────────────────────────────
        const hello = yield* fetchJsonReady<{
          marker: string;
          via: string;
          echo: string | null;
        }>(`${url}/api/hello?echo=dev`);
        expect(hello.marker).toBe("SVELTEKIT_AWS_EFFECT_KIT_API");
        expect(hello.via).toBe("kit");
        expect(hello.echo).toBe("dev");

        // ── An unknown route INSIDE the claim is the effect's own 404 —
        // the fixture's RouteNotFound failure renders as the fetch's OWN
        // 404 response (empty body, not kit's HTML error page) ───────────
        const insideMiss = yield* Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const res = yield* client.get(
            `${url}/api/effect/definitely-not-here`,
          );
          return { status: res.status, body: yield* res.text };
        });
        expect(insideMiss.status).toBe(404);
        expect(insideMiss.body).not.toContain("<html");

        // ── Framework surface: kit SSR outside the effect routes ─────────
        yield* expectUrlContains(
          `${url}/`,
          "SVELTEKIT_AWS_EFFECT_PAGE_MARKER",
          { timeout: "120 seconds", label: "kit SSR home (dev)" },
        );

        yield* stack.destroy();

        // The REAL bucket was deleted on destroy (its row is
        // mode-agnostic, so the live provider handles the delete even in a
        // dev run).
        yield* S3.headBucket({ Bucket: data.bucketName }).pipe(
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
          inBucketRegion,
        );
      }),
    { timeout: 600_000 },
  );
});
