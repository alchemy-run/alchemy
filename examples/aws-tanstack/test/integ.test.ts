import * as AWS from "alchemy/AWS";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { createHash } from "node:crypto";
import { toJSONAsync } from "seroval";
import Stack from "../alchemy.run.ts";

// A fresh CloudFront distribution (and the Lambda behind it) can serve
// transient 404/5xx responses while it propagates. `Test.getWhenReady`
// fails on that cold-start window and retries until the site serves a
// real response.
const { executeWhenReady, getWhenReady } = Test;

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

// The first deploy runs the full TanStack Start build AND creates a
// CloudFront distribution (~5-10 minutes), so give the hook far more
// headroom than the default 120s.
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

// TanStack server functions are the site's public API (src/server/visits.ts).
// Start's production compiler assigns each one a deterministic id — the
// sha256 of "<root-relative file>--<variable>_createServerFn_handler" —
// served under the default /_serverFn base. This is exactly the URL the
// compiled browser client posts to.
const serverFnUrl = (base: string, name: string) =>
  `${base}/_serverFn/${createHash("sha256")
    .update(`src/server/visits.ts--${name}_createServerFn_handler`)
    .digest("hex")}`;

// One server-function call, as Start's client runtime sends it: POST with
// the x-tsr-serverFn marker header and, when the fn takes data, the
// seroval-serialized `{ data }` payload as JSON.
const callServerFn = (base: string, name: string, data?: unknown) =>
  Effect.gen(function* () {
    let request = HttpClientRequest.post(serverFnUrl(base, name)).pipe(
      HttpClientRequest.setHeader("x-tsr-serverFn", "true"),
      // Start's transport rejects cross-site-looking POSTs (403): a real
      // browser call is same-origin, so imitate it.
      HttpClientRequest.setHeader("origin", new URL(base).origin),
    );
    if (data !== undefined) {
      const payload = yield* Effect.promise(() => toJSONAsync({ data }));
      request = request.pipe(
        HttpClientRequest.bodyText(JSON.stringify(payload), "application/json"),
      );
    }
    return yield* executeWhenReady(request);
  });

// The page server-renders the demo state (the loader runs the server
// functions in-process during SSR) — read it back from the HTML.
const readCount = Effect.fn(function* (base: string, testid: string) {
  const html = yield* getBodyWhenReady(base, `data-testid="${testid}"`);
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
  "compiles tailwind from vite.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(url);
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
    const cssUrl = href.startsWith("http") ? href : `${url}${href}`;
    const css = yield* getBodyWhenReady(cssUrl, ".text-3xl");
    expect(css).toContain(".text-3xl");
    expect(css).toContain(".font-bold");
  }),
  { timeout: 180_000 },
);

test(
  "SSR loader renders the backend value into the HTML",
  Effect.gen(function* () {
    const url = yield* base;

    // The loader called `getVisits()` — the server function dispatches
    // `backend.visits()` through the value form (direct in-process
    // dispatch) — so the DynamoDB-backed count is already in the
    // server-rendered HTML.
    const html = yield* getBodyWhenReady(url, "Server-rendered visits:");
    expect(html).toContain("Server-rendered visits:");
    const count = html.match(
      /data-testid="count"[^>]*>(?:<!--[^>]*-->)?\s*(\d+)/,
    );
    expect(count).not.toBeNull();
    expect(Number(count![1])).toBeGreaterThanOrEqual(0);
    // The queue section's initial state is server-rendered the same way
    // (the loader calls `getProcessed()`).
    expect(html).toContain("Queue-processed:");
  }),
  { timeout: 180_000 },
);

test(
  "bump server function round-trips through DynamoDB (Start's transport)",
  Effect.gen(function* () {
    const url = yield* base;

    const before = yield* readCount(url, "count");

    // The transport-level proof: POST the compiled `bumpVisits` server
    // function exactly as the browser client would. The CloudFront edge
    // router forwards the miss to the server Lambda, where the handler
    // calls `backend.bump()` in-process (value form) against the DynamoDB
    // capability bindings (env + IAM) collected at plan time.
    const bumped = yield* callServerFn(url, "bumpVisits");
    expect(bumped.status).toBe(200);

    // The write is visible to the next server render (poll through any
    // stale edge cache).
    const after = yield* readCount(url, "count").pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (count) => count > before,
        times: 15,
      }),
    );
    expect(after).toBeGreaterThan(before);
  }),
  { timeout: 180_000 },
);

test(
  "queue leg: enqueue → same-Lambda consumer → processed",
  Effect.gen(function* () {
    const url = yield* base;
    // Each run sends a unique marker so the assertion can't match a
    // message from an earlier run.
    const marker = `queue-marker-${crypto.randomUUID()}`;

    // Baseline first — a rerun against a kept deployment (NO_DESTROY) may
    // already have processed messages.
    const before = yield* readCount(url, "processed-count");

    // Produce through the `enqueueJob` server function; the CONSUMER runs
    // out of band on the SAME server Lambda (single-handler entry), whose
    // event-source mapping was registered by the same backend module.
    const sent = yield* callServerFn(url, "enqueueJob", marker);
    expect(sent.status).toBe(200);

    // Poll the server-rendered page until the consumer's DynamoDB writes
    // are observed by the SSR loader.
    const after = yield* readCount(url, "processed-count").pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (count) => count > before,
        times: 45,
      }),
    );
    expect(after).toBeGreaterThan(before);
    const html = yield* getBodyWhenReady(url, "Queue-processed:");
    expect(html).toContain(marker);
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
    // Warm first so the cold-start window can't read as the gate.
    yield* getWhenReady(`${url}/healthz`);
    const client = yield* HttpClient.HttpClient;
    const denied = yield* client.get(`${url}/api/admin/secret`);
    expect(denied.status).toBe(403);
    const allowed = yield* client.execute(
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

    // The consumer runs on the SAME Lambda (single-handler entry): poll
    // until its DynamoDB writes land.
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
    // Inline settle: the write happened BEFORE the response resolved —
    // the next read observes it (small poll for DynamoDB consistency).
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
  "the schema-less RPC wire is not publicly served",
  Effect.gen(function* () {
    const url = yield* base;

    // Warm the deployment first so the cold-start 404 window can't be
    // mistaken for the assertion below.
    yield* getBodyWhenReady(url, "Server-rendered visits:");

    // createClient's in-process dispatch has no HTTP surface: the old
    // universal `POST /api/__rpc/<method>` path reaches the server Lambda
    // (the edge router forwards `/api/*` there first) but no RPC envelope
    // answers — the framework's own not-found handling does.
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
