import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import { expectUrlContains } from "../../Cloudflare/Utils/Http.ts";
import { dockerAvailable } from "../Local/fixtures/raw.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: AWS.providers(), dev: true });

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

class DevResponseMismatch extends Data.TaggedError("DevResponseMismatch")<{
  url: string;
  detail: string;
}> {
  override get message() {
    return `${this.url} :: ${this.detail}`;
  }
}

/**
 * Fetch `url` until it answers `status` with a body containing `marker` —
 * for effect-served routes whose first request pays the lazy layer build,
 * and for real-404 assertions `expectUrlContains` can't make (it requires
 * `res.ok`).
 */
const expectStatusBody = (url: string, status: number, marker: string) =>
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
      new DevResponseMismatch({
        url,
        detail: e instanceof Error ? e.message : String(e),
      }),
  }).pipe(
    Effect.filterOrFail(
      (r) => r.status === status && r.body.includes(marker),
      (r) =>
        new DevResponseMismatch({
          url,
          detail: `expected ${status} with "${marker}", got ${r.status} ${r.body.slice(0, 4000)}`,
        }),
    ),
    Effect.retry({
      schedule: Schedule.min([
        Schedule.exponential("500 millis", 1.5),
        Schedule.spaced("4 seconds"),
      ]),
      times: 10,
    }),
  );

describe("AWS.Website.Astro local", () => {
  test.provider(
    "dev runs Astro's own dev server with no cloud resources",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-astro-aws-local-",
          tempRoot,
          entries: fixtureEntries,
        });

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* AWS.Website.Astro("AstroSite", {
              rootDir,
              // Pin the dev server to a deterministic port — `dev.port`
              // flows through Server's port probe into the framework kit.
              dev: { port: 43117 },
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
        // The preferred `dev.port` was honored.
        expect(url).toContain(":43117");
        expect(deployed.site.distribution).toBeUndefined();
        expect(deployed.site.server).toBeUndefined();
        expect(deployed.site.bucket).toBeUndefined();

        // SSR page served by the astro dev server (native HMR toolchain).
        yield* expectUrlContains(`${url}/`, "ASTRO_AWS_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "dev SSR home page",
        });
        // API route through the dev server.
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "ASTRO_AWS_API_MARKER",
          { label: "API route (dev)" },
        );
        yield* expectUrlContains(`${url}/api/hello?echo=dev`, "dev", {
          label: "API route query echo (dev)",
        });

        // ── HMR: edit the API route in place. The stack is NOT re-applied —
        // astro's dev rebuild must pick the change up and serve it through
        // the same URL ───────────────────────────────────────────────────
        const helloPath = path.join(rootDir, "src/pages/api/hello.ts");
        const hello = yield* fs.readFileString(helloPath);
        yield* fs.writeFileString(
          helloPath,
          hello.replace("ASTRO_AWS_API_MARKER", "ASTRO_AWS_API_MARKER_V2"),
        );
        yield* expectUrlContains(
          `${url}/api/hello?echo=dev`,
          "ASTRO_AWS_API_MARKER_V2",
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
// Effectful Website (DESIGN §6.2c, §7-AWS): the Astro construct's third
// argument is an Effect program whose `fetch` owns `server.routes` —
// delivered in dev through the generated fetchable wrapper running inside
// Astro's own Node dev server (the sidecar process), which IS the AWS
// Lambda programming model. The DynamoDB capability bindings collected at
// plan resolve against the REAL cloud table (the fixture pins it
// `Alchemy.remote()`, the SDK-backed dev model) with the developer's
// ambient credentials, while the effect program also deploys into the
// floci Lambda emulator as the sibling function (hence the Docker gate).
// ─────────────────────────────────────────────────────────────────────

describe("AWS.Website.Astro local (effectful)", () => {
  test.provider.skipIf(!dockerAvailable)(
    "effectful Astro dev: /api/* serves through the Effect fetch with real AWS bindings",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Private clone; the clone's own `site.ts` is the program module
        // (`main: import.meta.url` anchors the cloned path, so the
        // generated fetchable wrapper imports the clone, not the source
        // fixture).
        const rootDir = yield* cloneFixture(effectFixtureDir, {
          prefix: "alchemy-astro-effect-aws-dev-",
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

        // The site is the framework's own dev server; no CDN resources
        // exist at all.
        const url = site.url! as string;
        expect(url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1)/);
        // The dev URL carries a trailing slash — join paths through URL so
        // pathnames never double up (`//api/...` would miss the route
        // globs).
        const at = (path: string) => new URL(path, url).toString();
        expect(site.bucket).toBeUndefined();
        expect(site.distribution).toBeUndefined();
        expect(site.files).toBeUndefined();

        // The sibling effect Lambda deployed into the floci emulator: a
        // dummy-account ARN is proof no real Lambda was created...
        expect(site.server.functionArn).toContain(":000000000000:");
        // ...while the impl-bound DynamoDB table is REAL — the fixture
        // pins it `Alchemy.remote()` because the serve shell's capability
        // clients resolve ambient credentials against the real AWS
        // endpoint (the SDK-backed dev model).
        expect(table.tableArn).toMatch(/^arn:aws:dynamodb:/);
        expect(table.tableArn).not.toContain(":000000000000:");

        // SSR page outside `server.routes` renders through Astro as usual.
        yield* expectUrlContains(at("/"), "astro-aws-effect-home", {
          timeout: "120 seconds",
          label: "astro dev effect SSR home",
        });

        // The effect fetch owns `/api/*`: a plain effect-served route
        // (first request pays the lazy layer build inside the dev
        // server)...
        yield* expectStatusBody(
          at("/api/marker"),
          200,
          "astro-aws-effect-fetch",
        );

        // ...and a DynamoDB round-trip through the capability bindings
        // against the REAL table (ambient credentials).
        const marker = `astro-aws-effect-dev-${Date.now()}`;
        yield* expectStatusBody(
          at(`/api/db?key=dev-key&put=${marker}`),
          200,
          `"value":"${marker}"`,
        );

        // Out-of-band proof via distilled: the write landed in the real
        // cloud table.
        const item = yield* dynamodb
          .getItem({
            TableName: table.tableName,
            Key: { pk: { S: "dev-key" } },
            ConsistentRead: true,
          })
          .pipe(Effect.orDie);
        expect(item.Item?.value?.S).toBe(marker);

        // Exclusion glob: `/api/astro-echo` is carved OUT of the effect
        // claim (`!/api/astro-echo` in server.routes) — Astro's own
        // endpoint answers; the effect fetch never sees the path.
        yield* expectStatusBody(
          at("/api/astro-echo"),
          200,
          "astro-endpoint-echo",
        );

        // An unknown route INSIDE the claim is the effect fetch's own 404
        // (its RouteNotFound failure renders as its OWN 404 response —
        // empty body, not Astro's HTML 404 page).
        const insideMiss = yield* Effect.tryPromise(async (signal) => {
          const res = await fetch(at("/api/definitely-not-here"), {
            signal,
            cache: "no-store",
            headers: { "cache-control": "no-cache", accept: "*/*" },
          });
          return { status: res.status, body: await res.text() };
        });
        expect(insideMiss.status).toBe(404);
        expect(insideMiss.body).not.toContain("<html");

        // Prerender-marked pages render on demand in dev (the guard case
        // proper — the build-time prerenderer never loading the effect
        // graph — is pinned by the live build test).
        yield* expectUrlContains(
          at("/about/"),
          "astro-aws-effect-prerendered",
          { timeout: "60 seconds", label: "astro dev effect prerender route" },
        );

        // Static asset from `public/`.
        yield* expectUrlContains(
          at("/static.txt"),
          "astro-aws-effect-static-asset",
          { timeout: "60 seconds", label: "astro dev effect static asset" },
        );

        yield* stack.destroy();

        // The REAL table was deleted from the cloud on destroy (its row
        // is stamped live via the `remote()` pin, so the live provider
        // handles the delete even in a dev run).
        const gone = yield* dynamodb
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
        expect(gone).toBe(true);
      }),
    { timeout: 600_000 },
  );
});
