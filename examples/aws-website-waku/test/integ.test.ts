import * as AWS from "alchemy/AWS";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

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
const getBodyWhenReady = Effect.fn(
  function* (url: string, expected: string) {
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

// The first deploy runs the full Waku build AND creates a CloudFront
// distribution (~5-10 minutes), so give the hook far more headroom than
// the default 120s.
const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
  timeout: 1_200_000,
});
// Deleting the CloudFront distribution takes several minutes too.
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 1_200_000,
});

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a CloudFront url");
  return String(url).replace(/\/+$/, "");
});

// The page server-renders the backend state (the RSC page calls the
// value-form client during SSR) — read a counter back from the HTML.
const readCount = Effect.fn(function* (baseUrl: string, testid: string) {
  const html = yield* getBodyWhenReady(baseUrl, `data-testid="${testid}"`);
  const match = html.match(
    new RegExp(`data-testid="${testid}"[^>]*>(?:<!--[^>]*-->)?\\s*(\\d+)`),
  );
  expect(match).not.toBeNull();
  return Number(match![1]);
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
  "serves the server-rendered home page",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(
      url,
      "This page is rendered by the server on every request.",
    );
    // The `GREETING` env value from src/backend.ts, read via `getEnv` in
    // the dynamic RSC page — proves the Lambda rendered it at request time.
    expect(html).toContain("Hello from alchemy");
  }),
  { timeout: 180_000 },
);

test(
  "compiles tailwind from waku.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(url, "text-3xl");

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

test(
  "SSR page renders the backend value (value-form createClient)",
  Effect.gen(function* () {
    const url = yield* base;

    // The RSC page called `backend.visits()` — in-process dispatch through
    // the value form — so the DynamoDB-backed count is already in the
    // server-rendered HTML.
    const before = yield* readCount(url, "count");
    expect(before).toBeGreaterThanOrEqual(0);

    // Bump through the effect fetch, then observe the next server render.
    const bumped = yield* getWhenReady(`${url}/api/bump`);
    expect(bumped.status).toBe(200);

    const after = yield* readCount(url, "count").pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (count) => count > before,
        times: 10,
      }),
    );
    expect(after).toBeGreaterThan(before);
  }),
  { timeout: 180_000 },
);

test(
  "the mount's own route answers without the framework (healthz)",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("ok");
  }),
  { timeout: 180_000 },
);

test(
  "the mount's admin gate runs ahead of both worlds",
  Effect.gen(function* () {
    const url = yield* base;
    // Warm first so the cold-start window can't masquerade as the gate.
    yield* getWhenReady(`${url}/healthz`);

    const client = yield* HttpClient.HttpClient;
    const denied = yield* client.get(`${url}/api/admin/secret`);
    expect(denied.status).toBe(403);
    expect(yield* denied.text).toBe("forbidden");

    const passed = yield* client.execute(
      HttpClientRequest.get(`${url}/api/admin/secret`).pipe(
        HttpClientRequest.setHeader("x-admin-key", "letmein"),
      ),
    );
    expect(passed.status).toBe(200);
    expect((yield* passed.json) as object).toEqual({ admin: true });
  }),
  { timeout: 180_000 },
);

test(
  "streaming route serves the full body through the streamified entry",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/api/stream?n=4`);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("0\n1\n2\n3\n");
  }),
  { timeout: 180_000 },
);

test(
  "request-scope finalizer settles inline (Lambda semantics)",
  Effect.gen(function* () {
    const url = yield* base;
    const marker = `fin-${crypto.randomUUID().slice(0, 8)}`;

    const res = yield* getWhenReady(`${url}/api/finalizer?v=${marker}`);
    expect(res.status).toBe(200);

    const client = yield* HttpClient.HttpClient;
    const value = yield* Effect.gen(function* () {
      const kv = yield* client.get(`${url}/api/kv?key=finalizer-last`);
      return ((yield* kv.json) as { value: string | null }).value;
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (value) => value === marker,
        times: 20,
      }),
    );
    expect(value).toBe(marker);
  }),
  { timeout: 180_000 },
);

test(
  "queue leg: enqueue → same-Lambda consumer → processed",
  Effect.gen(function* () {
    const url = yield* base;
    const marker = `queue-marker-${crypto.randomUUID()}`;

    // Baseline first — a rerun against a kept deployment (NO_DESTROY) may
    // already have processed messages.
    const before = yield* readCount(url, "processed-count");

    const sent = yield* getWhenReady(`${url}/api/enqueue?m=${marker}`);
    expect(sent.status).toBe(200);

    // Poll until the consumer's DynamoDB writes are observed — the
    // event-source mapping targets the SITE's own server Lambda
    // (single-handler delivery), so the same deployment consumes it.
    const client = yield* HttpClient.HttpClient;
    const last = yield* Effect.gen(function* () {
      const kv = yield* client.get(`${url}/api/kv?key=processed-last`);
      return ((yield* kv.json) as { value: string | null }).value;
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (value) => value === marker,
        times: 60,
      }),
    );
    expect(last).toBe(marker);

    // The SSR page renders the consumer state through the value form too.
    const after = yield* readCount(url, "processed-count");
    expect(after).toBeGreaterThan(before);
  }),
  { timeout: 300_000 },
);

test(
  "the schema-less RPC wire is not publicly served",
  Effect.gen(function* () {
    const url = yield* base;

    // Warm the deployment first so the cold-start 404 window can't be
    // mistaken for the assertion below.
    yield* getBodyWhenReady(url, "Server-rendered visits:");

    // createClient's in-process dispatch has no HTTP surface: the old
    // universal `POST /api/__rpc/<method>` path is answered by the effect
    // fetch's own 404, never an RPC envelope.
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.execute(
      HttpClientRequest.post(`${url}/api/__rpc/bump`).pipe(
        HttpClientRequest.bodyText("[]", "application/json"),
      ),
    );
    expect(res.status).toBe(404);
    const body = yield* res.text;
    expect(body).not.toContain('"value"');
  }),
  { timeout: 180_000 },
);
