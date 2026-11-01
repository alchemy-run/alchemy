import { expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Alchemy from "alchemy";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

// A fresh STACKIT deployment can serve transient 404/5xx responses
// while it propagates. `Test.getWhenReady` fails on that cold-start
// window and retries until the site serves a real response.
const { getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// While the CDN and the function are still
// propagating, a 200 body can be stale — the status alone can't
// distinguish "not yet" from "served", so retry until the body matches.
const getBodyWhenReady = (url: string, expected: string) =>
  Effect.gen(function* () {
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const body = yield* res.text;
    if (!body.includes(expected)) {
      return yield* Effect.fail(new AssetNotReady({ body }));
    }
    return body;
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof AssetNotReady,
      schedule: Schedule.max([
        Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("3 seconds")]),
        Schedule.recurs(20),
      ]),
    }),
  );

// Out-of-band calls to the STACKIT APIs resolve the same credentials the deploy uses.
const StackitApi = Layer.mergeAll(Stackit.StackitAuth, Stackit.fromAuthProvider());

// An assets-only site needs a project and a service account, nothing else. Without
// credentials in the environment or a profile, the suite skips.
const hasCreds =
  !!process.env.STACKIT_SERVICE_ACCOUNT_KEY ||
  !!process.env.STACKIT_SERVICE_ACCOUNT_KEY_PATH ||
  !!process.env.ALCHEMY_PROFILE;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Stackit.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

// The first deploy runs the build, uploads the files and creates the distribution,
// so give the hook far more headroom than the default 120s.
if (!hasCreds) {
  test.skip("skipped without STACKIT credentials", Effect.void);
} else {
  const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
    timeout: 900_000,
  });
  // Destroying the stack takes a while too.
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
    timeout: 900_000,
  });

  const base = Effect.map(stack, ({ url }) => {
    if (!url) throw new Error("expected the site to expose a url");
    return String(url).replace(/\/+$/, "");
  });

  // Resolve an asset href from index.html against the site base.
  const resolve = (baseUrl: string, href: string) =>
    href.startsWith("http") ? href : `${baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;

  test(
    "deploys and exposes a url",
    Effect.gen(function* () {
      const { url } = yield* stack;
      expect(url).toBeString();
    }),
    { timeout: 180_000 },
  );

  test(
    "serves through the CDN, from a bucket, with no function",
    Effect.gen(function* () {
      const { url, serverUrl, projectId, distributionId, hostname } = yield* stack;
      expect(new URL(String(url)).hostname).toBe(String(hostname));
      expect(serverUrl).toBeUndefined();
      const { distribution } = yield* cdn.getDistribution({
        projectId: projectId!,
        distributionId: distributionId!,
      });
      expect(distribution.status).toBe("ACTIVE");
      const { backend } = distribution.config;
      expect(backend.type).toBe("bucket");
    }).pipe(Effect.provide(StackitApi)),
    { timeout: 180_000 },
  );

  test(
    "caches hashed files for good and HTML not at all",
    Effect.gen(function* () {
      const url = yield* base;
      const page = yield* getWhenReady(`${url}/index.html`);
      expect(page.status).toBe(200);
      expect(page.headers["cache-control"]).toContain("no-store");
      const asset = /(?:src|href)="([^"]*\/assets\/[^"]+)"/.exec(yield* page.text)?.[1];
      expect(asset).toBeString();
      const hashed = yield* getWhenReady(new URL(asset!, `${url}/`).href);
      expect(hashed.status).toBe(200);
      expect(hashed.headers["cache-control"]).toContain("immutable");
    }),
    { timeout: 180_000 },
  );

  // A bucket has no object for `/`, and STACKIT documents no default document for a
  // bucket origin, so this is the first thing to look at on a live run.
  test(
    "serves the index page at /",
    Effect.gen(function* () {
      const url = yield* base;
      const res = yield* getWhenReady(`${url}/`);
      expect(res.status).toBe(200);
    }),
    { timeout: 180_000 },
  );

  test(
    "serves the index HTML",
    Effect.gen(function* () {
      const url = yield* base;
      const html = yield* getBodyWhenReady(`${url}/index.html`, '<div id="root">');
      expect(html).toContain("<title>Foldkit on STACKIT</title>");
    }),
    { timeout: 180_000 },
  );

  test(
    "ships the Foldkit app in the client bundle",
    Effect.gen(function* () {
      const url = yield* base;
      // Client-only SPA: the greeting and card view render in the browser, so
      // assert on the built JS bundle Vite links from index.html.
      const html = yield* getBodyWhenReady(`${url}/index.html`, '<script type="module"');
      const script = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/);
      expect(script).not.toBeNull();
      const js = yield* getBodyWhenReady(resolve(url, script![1]!), "Hello from Foldkit!");
      expect(js).toContain("Hello from Foldkit!");
      expect(js).toContain("Styled with Tailwind CSS");
    }),
    { timeout: 180_000 },
  );

  test(
    "compiles tailwind from vite.config.ts",
    Effect.gen(function* () {
      const url = yield* base;
      // Assert on the compiled stylesheet Vite links from index.html — the
      // compiled rule for a utility used in src/main.ts only exists if the
      // @tailwindcss/vite plugin from the project's own vite.config.ts ran.
      const html = yield* getBodyWhenReady(`${url}/index.html`, "stylesheet");
      const link = html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
      expect(link).not.toBeNull();
      const css = yield* getBodyWhenReady(resolve(url, link![1]!), ".text-3xl");
      expect(css).toContain(".text-3xl");
    }),
    { timeout: 180_000 },
  );
}
