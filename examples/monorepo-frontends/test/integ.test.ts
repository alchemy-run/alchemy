/**
 * Live deploy of the whole monorepo stack: four effectful AWS Websites,
 * each built from a NESTED workspace package (`rootDir:
 * "packages/<framework>"`) out of the single root alchemy.run.ts. For
 * each framework the test drives `/api/marker` (the effect fetch riding
 * the framework's server Lambda) and a static asset through CloudFront.
 */
import * as AWS from "alchemy/AWS";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";
import { MARKER as ASTRO_MARKER } from "../packages/astro/src/backend.ts";
import { MARKER as NEXTJS_MARKER } from "../packages/nextjs/src/backend.ts";
import { MARKER as NUXT_MARKER } from "../packages/nuxt/src/backend.ts";
import { MARKER as SVELTEKIT_MARKER } from "../packages/sveltekit/src/backend.ts";

// A fresh CloudFront distribution (and the Lambda behind it) can serve
// transient 404/5xx responses while it propagates. `Test.getWhenReady`
// fails on that cold-start window and retries until the site serves a
// real response.
const { getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// While the asset manifest and CloudFront edge caches are still
// propagating, a 200 body can be stale — the status alone can't
// distinguish "not yet" from "served", so retry until the body matches.
const getBodyWhenReady = Effect.fn(function* (url: string, expected: string) {
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const body = yield* res.text;
    if (!body.includes(expected)) {
      return yield* Effect.fail(new AssetNotReady({ body }));
    }
    return body;
  },
    Effect.retry({
      while: (error) => error instanceof AssetNotReady,
      schedule: Schedule.max([
        Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("3 seconds"),
        ]),
        Schedule.recurs(20),
      ]),
    }),
  );

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
  state: AWS.state(),
  stage: "test",
});

// The first deploy runs four framework builds (Next/OpenNext is the
// slowest) AND creates four CloudFront distributions concurrently
// (~5-10 minutes each, deployed in parallel), so give the hook far more
// headroom than the default 120s.
const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
  timeout: 1_800_000,
});
// Deleting the CloudFront distributions takes several minutes too.
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 1_800_000,
});

type Outputs = {
  nextjsUrl: string;
  nuxtUrl: string;
  astroUrl: string;
  sveltekitUrl: string;
};

const base = (key: keyof Outputs) =>
  Effect.map(stack, (outputs) => {
    const url = (outputs as Outputs)[key];
    if (!url) throw new Error(`expected ${key} in the stack outputs`);
    return String(url).replace(/\/+$/, "");
  });

test(
  "deploys and exposes a url per framework",
  Effect.gen(function* () {
    const outputs = (yield* stack) as Outputs;
    expect(outputs.nextjsUrl).toBeString();
    expect(outputs.nuxtUrl).toBeString();
    expect(outputs.astroUrl).toBeString();
    expect(outputs.sveltekitUrl).toBeString();
  }),
  { timeout: 180_000 },
);

/** Assert the effect fetch serves the marker through CloudFront. */
const assertMarker = (key: keyof Outputs, marker: string) =>
  Effect.gen(function* () {
    const url = yield* base(key);
    const res = yield* getWhenReady(`${url}/api/marker`);
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { marker: string };
    expect(body.marker).toBe(marker);
  });

// In-repo ONLY: bun's isolated-install store breaks OpenNext's traced
// node_modules when the Lambda zip flattens the `next` symlink (see
// examples/aws-website-nextjs/README.md) — Lambda-served routes 500 with
// a missing @swc/helpers module. A standalone copy of this example
// passes. Set AWS_WEBSITE_NEXTJS_LAMBDA=1 to run it here.
const nextjsLambdaRoutesBroken = !process.env.AWS_WEBSITE_NEXTJS_LAMBDA;

test.skipIf(nextjsLambdaRoutesBroken)(
  "nextjs: effect fetch serves /api/marker",
  assertMarker("nextjsUrl", NEXTJS_MARKER),
  { timeout: 180_000 },
);

test(
  "nuxt: effect fetch serves /api/marker",
  assertMarker("nuxtUrl", NUXT_MARKER),
  { timeout: 180_000 },
);

test(
  "astro: effect fetch serves /api/marker",
  assertMarker("astroUrl", ASTRO_MARKER),
  { timeout: 180_000 },
);

test(
  "sveltekit: effect fetch serves /api/marker",
  assertMarker("sveltekitUrl", SVELTEKIT_MARKER),
  { timeout: 180_000 },
);

/** Assert the SSR page renders through the server Lambda. */
const assertPage = (key: keyof Outputs, pageMarker: string) =>
  Effect.gen(function* () {
    const url = yield* base(key);
    const html = yield* getBodyWhenReady(url, pageMarker);
    expect(html).toContain(pageMarker);
  });

test.skipIf(nextjsLambdaRoutesBroken)(
  "nextjs: serves the server-rendered home page",
  assertPage("nextjsUrl", "monorepo-nextjs-page"),
  { timeout: 180_000 },
);

test(
  "nuxt: serves the server-rendered home page",
  assertPage("nuxtUrl", "monorepo-nuxt-page"),
  { timeout: 180_000 },
);

test(
  "astro: serves the server-rendered home page",
  assertPage("astroUrl", "monorepo-astro-page"),
  { timeout: 180_000 },
);

test(
  "sveltekit: serves the server-rendered home page",
  assertPage("sveltekitUrl", "monorepo-sveltekit-page"),
  { timeout: 180_000 },
);

/** Assert a static asset uploaded from the nested package serves. */
const assertRobots = (key: keyof Outputs) =>
  Effect.gen(function* () {
    const url = yield* base(key);
    const body = yield* getBodyWhenReady(`${url}/robots.txt`, "User-agent: *");
    expect(body).toContain("User-agent: *");
  });

test("nextjs: serves a static asset from public/", assertRobots("nextjsUrl"), {
  timeout: 180_000,
});

test("nuxt: serves a static asset from public/", assertRobots("nuxtUrl"), {
  timeout: 180_000,
});

test("astro: serves a static asset from public/", assertRobots("astroUrl"), {
  timeout: 180_000,
});

test(
  "sveltekit: serves a static asset from static/",
  assertRobots("sveltekitUrl"),
  { timeout: 180_000 },
);
