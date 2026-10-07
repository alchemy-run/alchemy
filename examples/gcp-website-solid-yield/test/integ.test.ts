import { describe, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

// A fresh Cloud Run revision can answer transient 404/5xx responses while
// its URL starts serving. `Test.getWhenReady` retries through that
// cold-start window until the service serves a real response.
const { getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// Retry until the body matches — the status alone can't distinguish a
// cold start from a served page.
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

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GCP.providers(),
  state: Alchemy.localState(),
});

// Both services are container images built locally, so the suite needs Docker.
const dockerAvailable =
  spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status === 0;

const trim = (url: string | undefined) => {
  if (!url) throw new Error("expected a url");
  return url.replace(/\/+$/, "");
};

const resolve = (base: string, href: string) =>
  href.startsWith("http") ? href : `${base}${href.startsWith("/") ? "" : "/"}${href}`;

describe.skipIf(!dockerAvailable)("gcp-website-solid-yield", () => {
  // The first deploy runs the Vite build, builds and pushes both images, and
  // rolls out two Cloud Run services, so give the hook plenty of headroom.
  const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
    timeout: 1_200_000,
  });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
    timeout: 1_200_000,
  });

  test(
    "serves the index HTML",
    Effect.gen(function* () {
      const url = trim((yield* stack).url);
      const html = yield* getBodyWhenReady(url, '<div id="root">');
      expect(html).toContain("<title>solid-yield on GCP</title>");
    }),
    { timeout: 180_000 },
  );

  test(
    "ships the solid-yield app and the API url in the client bundle",
    Effect.gen(function* () {
      const { url, apiUrl } = yield* stack;
      const base = trim(url);
      const html = yield* getBodyWhenReady(base, '<script type="module"');
      const script = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/);
      expect(script).not.toBeNull();
      const js = yield* getBodyWhenReady(resolve(base, script![1]!), "Hello from solid-yield!");
      expect(js).toContain("Styled with Tailwind CSS");
      expect(js).toContain(trim(apiUrl));
    }),
    { timeout: 180_000 },
  );

  test(
    "compiles tailwind from vite.config.ts",
    Effect.gen(function* () {
      const base = trim((yield* stack).url);
      const html = yield* getBodyWhenReady(base, "stylesheet");
      const link = html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
      expect(link).not.toBeNull();
      const css = yield* getBodyWhenReady(resolve(base, link![1]!), ".text-3xl");
      expect(css).toContain(".text-3xl");
    }),
    { timeout: 180_000 },
  );

  test(
    "the API serves the greeting",
    Effect.gen(function* () {
      const api = trim((yield* stack).apiUrl);
      const body = yield* getBodyWhenReady(`${api}/api/greeting`, "Hello from the GCP API!");
      expect(JSON.parse(body)).toEqual({
        message: "Hello from the GCP API!",
        platform: "GCP",
      });
    }),
    { timeout: 180_000 },
  );
});
