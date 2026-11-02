import { expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Alchemy from "alchemy";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

// A fresh distribution can serve transient 404/5xx responses while it propagates.
// `Test.getWhenReady` fails on that cold-start window and retries until the site
// serves a real response.
const { getWhenReady } = Test;

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
    "serves the index page without caching it",
    Effect.gen(function* () {
      const url = yield* base;
      const res = yield* getWhenReady(`${url}/index.html`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["cache-control"]).toContain("no-store");
      expect(yield* res.text).toContain("STACKIT static site on Object Storage and the CDN");
    }),
    { timeout: 180_000 },
  );

  test(
    "serves a nested page at its directory's URL",
    Effect.gen(function* () {
      const url = yield* base;
      for (const page of ["/docs/index.html", "/docs", "/docs/"]) {
        const res = yield* getWhenReady(`${url}${page}`);
        expect(res.status).toBe(200);
        expect(yield* res.text).toContain("Static hosting can ship multiple pages too.");
      }
    }),
    { timeout: 180_000 },
  );

  test(
    "serves the stylesheet with its content type",
    Effect.gen(function* () {
      const url = yield* base;
      const res = yield* getWhenReady(`${url}/styles.css`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/css");
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
}
