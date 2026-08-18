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
const { executeWhenReady, getWhenReady } = Test;

// One request against the public API — the nitro server routes in
// server/api/, which dispatch the backend in-process (createClient's value
// form). This is the exact request the browser sends.
const postJsonWhenReady = (url: string, body?: unknown) =>
  executeWhenReady(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText(
        JSON.stringify(body ?? {}),
        "application/json",
      ),
    ),
  );

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

// The first deploy runs the full Nuxt build AND creates a CloudFront
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
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    expect(html).toContain("Nuxt on AWS");
    // The SSR seam (useFetch running the nitro route in-process, the
    // value form) rendered the counter.
    expect(html).toContain("Server-rendered visits:");
    expect(html).toContain("Queue-processed:");
  }),
  { timeout: 180_000 },
);

test(
  "serves the plain nitro api route",
  Effect.gen(function* () {
    // /api/jobs is nitro's own route calling the effectful backend in the
    // same Lambda, alongside the routes that dispatch the backend. This
    // pins the coexistence contract end-to-end.
    const url = yield* base;
    const body = yield* getBodyWhenReady(`${url}/api/jobs`, "count");
    expect(JSON.parse(body)).toHaveProperty("count");
  }),
  { timeout: 180_000 },
);

test(
  "serves the prerendered about page",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/about`);
    expect(res.status).toBe(200);
  }),
  { timeout: 180_000 },
);

test(
  "compiles tailwind from nuxt.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    // The utility classes on the home page prove the markup made it through
    // the build; the compiled rule proves the @tailwindcss/vite plugin from
    // the project's own nuxt.config.ts ran during it.
    const html = yield* getBodyWhenReady(url, "text-3xl");
    expect(html).toContain("text-3xl");

    // Nuxt either links the compiled stylesheet (/_nuxt/*.css) or inlines it
    // into a <style> tag depending on its inlineStyles feature — accept both.
    const links = [...html.matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1]!);
    let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1]!)
      .join("\n");
    for (const link of links) {
      const href = link.startsWith("http") ? link : `${url}${link}`;
      css += yield* getBodyWhenReady(href, "{");
    }
    expect(css).toContain(".text-3xl");
    expect(css).toContain("font-bold");
  }),
  { timeout: 180_000 },
);

test(
  "bumps the counter through the nitro route (POST /api/visits)",
  Effect.gen(function* () {
    const url = yield* base;
    // The exact request the "Bump visits" button sends. The route handler
    // value-imports the backend and calls `bump()` in-process — the
    // DynamoDB capability bindings (env + IAM) were collected at plan
    // time.
    const res = yield* postJsonWhenReady(`${url}/api/visits`);
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { count: number };
    expect(body.count).toBeGreaterThanOrEqual(1);
    // A second call increments — the method really runs per request.
    const again = yield* postJsonWhenReady(`${url}/api/visits`);
    const next = (yield* again.json) as { count: number };
    expect(next.count).toBeGreaterThan(body.count);
  }),
  { timeout: 180_000 },
);

test(
  "SSR renders the backend value loaded in-process by useFetch",
  Effect.gen(function* () {
    const url = yield* base;
    // The previous test bumped through the route; the page's useFetch
    // runs the same nitro handler in-process during SSR — the value form
    // reads the same DynamoDB counter and renders it into the HTML.
    const html = yield* getBodyWhenReady(url, "Server-rendered visits:");
    const visits = html.match(/data-testid="count"[^>]*>(\d+)/);
    expect(visits).not.toBeNull();
    expect(Number(visits![1])).toBeGreaterThanOrEqual(2);
  }),
  { timeout: 180_000 },
);

test(
  "queue round-trip: enqueue via the nitro route, the same-Lambda consumer catches up",
  Effect.gen(function* () {
    const url = yield* base;
    // Each run sends a unique marker so the assertion can't match a
    // message from an earlier run.
    const marker = `queue-marker-${crypto.randomUUID()}`;

    const readProcessed = Effect.gen(function* () {
      const res = yield* getWhenReady(`${url}/api/jobs`);
      expect(res.status).toBe(200);
      return (yield* res.json) as { count: number; last: string | null };
    });
    const before = yield* readProcessed;

    // `POST /api/jobs` sends to SQS and returns immediately; the CONSUMER
    // runs out of band on the SAME server Lambda (single-handler entry),
    // whose event-source mapping was registered by the same backend
    // module.
    const res = yield* postJsonWhenReady(`${url}/api/jobs`, {
      message: marker,
    });
    expect(res.status).toBe(200);

    // Bounded poll until the consumer's write lands in DynamoDB.
    const processed = yield* readProcessed.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (state) => state.count > before.count,
        times: 45,
      }),
    );
    expect(processed.count).toBeGreaterThan(before.count);
    expect(processed.last).toBe(marker);
  }),
  { timeout: 180_000 },
);

test(
  "serves a static asset from public/",
  Effect.gen(function* () {
    const url = yield* base;
    const body = yield* getBodyWhenReady(`${url}/robots.txt`, "User-agent: *");
    expect(body).toContain("User-agent: *");
  }),
  { timeout: 180_000 },
);

test(
  "the mount's own route answers without nitro (healthz)",
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
    // Warm first so the cold-start window can't read as the gate.
    yield* getWhenReady(`${url}/healthz`);
    const client = yield* HttpClient.HttpClient;
    const denied = yield* client.get(`${url}/api/admin/secret`);
    expect(denied.status).toBe(403);
    const allowed = yield* executeWhenReady(
      HttpClientRequest.get(`${url}/api/admin/secret`).pipe(
        HttpClientRequest.setHeader("x-admin-key", "letmein"),
      ),
    );
    expect(allowed.status).toBe(200);
    expect((yield* allowed.json) as object).toEqual({ admin: true });
  }),
  { timeout: 180_000 },
);

test(
  "effect queue leg over HTTP: /api/enqueue → same-Lambda consumer → /api/kv",
  Effect.gen(function* () {
    const url = yield* base;
    const marker = `http-queue-${crypto.randomUUID()}`;

    const readKv = (key: string) =>
      Effect.gen(function* () {
        const res = yield* getWhenReady(`${url}/api/kv?key=${key}`);
        expect(res.status).toBe(200);
        return ((yield* res.json) as { value: string | null }).value;
      });

    const before = Number((yield* readKv("processed-count")) ?? "0");
    const sent = yield* getWhenReady(`${url}/api/enqueue?m=${marker}`);
    expect(sent.status).toBe(200);

    yield* readKv("processed-count").pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (count) => Number(count ?? "0") > before,
        times: 45,
      }),
    );
    expect(yield* readKv("processed-last")).toBe(marker);
  }),
  { timeout: 240_000 },
);

test(
  "streaming route serves the full body through the streamified entry",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/api/stream?n=5`);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("0\n1\n2\n3\n4\n");
  }),
  { timeout: 180_000 },
);

test(
  "request-scope finalizer settles inline (Lambda semantics)",
  Effect.gen(function* () {
    const url = yield* base;
    const marker = `finalizer-${crypto.randomUUID()}`;
    const registered = yield* getWhenReady(`${url}/api/finalizer?v=${marker}`);
    expect(registered.status).toBe(200);
    const value = yield* Effect.gen(function* () {
      const res = yield* getWhenReady(`${url}/api/kv?key=finalizer-last`);
      return ((yield* res.json) as { value: string | null }).value;
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
  "nitro's own /api routes stay nitro's (the mount's exclusion globs)",
  Effect.gen(function* () {
    const url = yield* base;
    // /api/jobs and /api/visits are carved OUT of the mount's claim —
    // nitro's own scanned routes (value-form client inside) answer them.
    const res = yield* getWhenReady(`${url}/api/jobs`);
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { count: number };
    expect(typeof body.count).toBe("number");
  }),
  { timeout: 180_000 },
);
