import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

// Fresh `workers.dev` URLs transiently 404 while the route propagates.
// `HttpClient.execute`/`get` resolve successfully on that 404, so a plain
// `Effect.retry` never fires — these helpers fail on the cold-start window and
// retry until the real response (which may be 200/204/400) comes back.
const { executeWhenReady, getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// While the static-asset manifest is still propagating, requests can serve a
// stale or placeholder body with a 200 — the status alone can't distinguish
// "not yet" from "served", so retry until the body matches.
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
        Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("3 seconds"),
        ]),
        Schedule.recurs(20),
      ]),
    }),
  );

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)));
afterAll(
  Effect.gen(function* () {
    if (!process.env.NO_DESTROY) {
      yield* destroy(Stack);
    }
  }),
);

// The Effect API route served by the same Worker as the frontend —
// src/backend.ts claims exactly /api/hello and backs it with R2.
const route = (url: string, key?: string) =>
  key === undefined
    ? `${url}/api/hello`
    : `${url}/api/hello?key=${encodeURIComponent(key)}`;

test(
  "deploys and exposes a url",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeString();
  }),
  { timeout: 180_000 },
);

test(
  "compiles tailwind from vite.config.ts",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");
    const res = yield* getWhenReady(base);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    // The SSR'd markup uses Tailwind utilities...
    expect(html).toContain("text-3xl");
    // ...and links the stylesheet Vite emitted via the project-owned
    // vite.config.ts (the @tailwindcss/vite plugin), proving Alchemy loaded
    // the config file natively instead of the programmatic fallback.
    const match = html.match(/<link[^>]*href="([^"]+\.css[^"]*)"/);
    expect(match).not.toBeNull();
    const href = match![1]!;
    const cssUrl = href.startsWith("http") ? href : `${base}${href}`;
    const css = yield* getBodyWhenReady(cssUrl, ".text-3xl");
    expect(css).toContain(".text-3xl");
    expect(css).toContain(".font-bold");
  }),
  { timeout: 180_000 },
);

test(
  "Effect API round-trips through R2 (PUT then GET /api/hello)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    // Stable key so re-runs (e.g. NO_DESTROY=1) overwrite cleanly instead
    // of leaving stale objects behind.
    const key = "integ:roundtrip";

    const put = yield* executeWhenReady(
      HttpClientRequest.put(route(url, key)).pipe(
        HttpClientRequest.bodyText("hello-effect", "text/plain"),
      ),
    );
    expect(put.status).toBe(204);

    const get = yield* client.get(route(url, key));
    expect(get.status).toBe(200);
    expect(yield* get.text).toBe("hello-effect");
  }),
  { timeout: 180_000 },
);

test(
  "missing `key` returns 400",
  Effect.gen(function* () {
    const { url } = yield* stack;

    // `400` is the real answer; `getWhenReady` only retries the propagation
    // `404`/`5xx` window, so it returns the `400` as soon as the route is live.
    const res = yield* getWhenReady(route(url));
    expect(res.status).toBe(400);
  }),
);

test(
  "GET for a non-existent key returns 404",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* client.get(route(url, "integ:does-not-exist"));
    expect(res.status).toBe(404);
  }),
);
