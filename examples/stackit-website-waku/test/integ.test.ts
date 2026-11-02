import { expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as cdn from "@distilled.cloud/stackit/cdn";
import * as functions from "@distilled.cloud/stackit/functions";
import * as Alchemy from "alchemy";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

// A fresh distribution (and the function behind it) can serve
// transient 404/5xx responses while it propagates. `Test.getWhenReady`
// fails on that cold-start window and retries until the site serves a
// real response.
const { getWhenReady } = Test;

// Out-of-band calls to the STACKIT APIs resolve the same credentials the deploy uses.
const StackitApi = Layer.mergeAll(Stackit.StackitAuth, Stackit.fromAuthProvider());

// Functions is an alpha API an account may not be entitled to, and the image goes
// to a registry whose login STACKIT credentials don't provide. Without these, the
// suite skips.
const hasCreds =
  !!process.env.STACKIT_TEST_FUNCTIONS &&
  !!process.env.HARBOR_USERNAME &&
  !!process.env.HARBOR_CLI_SECRET;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Stackit.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

// The first deploy builds the site and its image, pushes the image, and creates the
// function and the distribution, so give the hook far more headroom than the default 120s.
if (!hasCreds) {
  test.skip(
    "skipped without STACKIT_TEST_FUNCTIONS, HARBOR_USERNAME and HARBOR_CLI_SECRET",
    Effect.void,
  );
} else {
  const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
    timeout: 1_500_000,
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
    "deploys and exposes a url",
    Effect.gen(function* () {
      const { url } = yield* stack;
      expect(url).toBeString();
    }),
    { timeout: 180_000 },
  );

  test(
    "serves through the CDN, with the function as its origin",
    Effect.gen(function* () {
      const { url, serverUrl, projectId, distributionId, hostname } = yield* stack;
      expect(new URL(String(url)).hostname).toBe(String(hostname));
      const { distribution } = yield* cdn.getDistribution({
        projectId: projectId!,
        distributionId: distributionId!,
      });
      expect(distribution.status).toBe("ACTIVE");
      const { backend } = distribution.config;
      expect(backend.type).toBe("http");
      if (backend.type === "http") {
        // STACKIT normalizes the origin, so compare the hosts.
        expect(new URL(backend.originUrl).host).toBe(new URL(String(serverUrl)).host);
      }
    }).pipe(Effect.provide(StackitApi)),
    { timeout: 180_000 },
  );

  test(
    "renders on the function",
    Effect.gen(function* () {
      const { serverUrl, projectId, functionId } = yield* stack;
      const observed = yield* functions.getFunction({
        projectId: projectId!,
        functionId: functionId!,
      });
      expect(observed.state).toBe("ACTIVE");
      // The function's own URL answers the same route, with no CDN in front of it.
      const origin = String(serverUrl).replace(/\/+$/, "");
      const res = yield* getWhenReady(`${origin}/`);
      expect(res.status).toBe(200);
      expect(yield* res.text).toContain("Hello from Waku on STACKIT!");
    }).pipe(Effect.provide(StackitApi)),
    { timeout: 180_000 },
  );

  test(
    "serves the server-rendered home page",
    Effect.gen(function* () {
      const url = yield* base;
      const res = yield* getWhenReady(url);
      expect(res.status).toBe(200);
      const html = yield* res.text;
      // The `GREETING` env value from alchemy.run.ts, read via `getEnv` in the
      // dynamic RSC page — proves the function rendered it at request time.
      expect(html).toContain("Hello from Waku on STACKIT!");
      expect(html).toContain("This page is rendered by the server on every request.");
    }),
    { timeout: 180_000 },
  );

  test(
    "compiles tailwind from waku.config.ts",
    Effect.gen(function* () {
      const url = yield* base;
      const res = yield* getWhenReady(url);
      expect(res.status).toBe(200);
      const html = yield* res.text;
      // The utility class from src/pages/index.tsx made it into the markup.
      expect(html).toContain("text-3xl");

      // Locate the emitted stylesheet. Waku links the compiled CSS bundle in
      // the document head; the @tailwindcss/vite plugin registered via
      // waku.config.ts's `vite` field is what compiles it.
      const links = [...html.matchAll(/<link\b[^>]*>/g)]
        .map((m) => m[0])
        .filter((tag) => /rel="stylesheet"/.test(tag))
        .map((tag) => /href="([^"]+)"/.exec(tag)?.[1])
        .filter((href): href is string => !!href);
      expect(links.length).toBeGreaterThan(0);

      let compiled = "";
      for (const href of links) {
        const cssUrl = href.startsWith("http")
          ? href
          : `${url}${href.startsWith("/") ? "" : "/"}${href}`;
        const cssRes = yield* getWhenReady(cssUrl);
        expect(cssRes.status).toBe(200);
        compiled += yield* cssRes.text;
      }

      // The compiled rule proves tailwind ran through the plugin from
      // waku.config.ts — not just that the class name appears in markup.
      expect(compiled).toContain(".text-3xl");
      expect(compiled).toContain("font-bold");
    }),
    { timeout: 180_000 },
  );

  test(
    "serves a static asset from public/",
    Effect.gen(function* () {
      const url = yield* base;
      const res = yield* getWhenReady(`${url}/hello.txt`);
      expect(res.status).toBe(200);
      expect(yield* res.text).toContain("hello from public/");
    }),
    { timeout: 180_000 },
  );
}
