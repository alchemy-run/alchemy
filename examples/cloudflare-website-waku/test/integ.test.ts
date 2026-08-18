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
// `Test.getWhenReady` fails on that cold-start window and retries until the
// worker serves a real response.
const { getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// While the deployment is still propagating, requests can serve a stale or
// placeholder body with a 200 — retry until the body matches.
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
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

// The first deploy runs the full Waku build, so give the hook more headroom
// than the default 120s.
const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
  timeout: 600_000,
});
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a workers.dev url");
  return url.replace(/\/+$/, "");
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
      "This page is rendered by the Worker on every request.",
    );
    // The `GREETING` env value from src/backend.ts, read via `getEnv` in
    // the dynamic RSC page — proves the Worker rendered it at request time.
    expect(html).toContain("Hello from alchemy");
  }),
  { timeout: 180_000 },
);

test(
  "compiles tailwind from waku.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(url, "text-3xl");
    // ...and links the stylesheet Vite emitted via the project-owned
    // waku.config.ts (the @tailwindcss/vite plugin), proving Alchemy loaded
    // the config file natively.
    const match = html.match(/<link[^>]*href="([^"]+\.css[^"]*)"/);
    expect(match).not.toBeNull();
    const href = match![1]!;
    const cssUrl = href.startsWith("http") ? href : `${url}${href}`;
    const css = yield* getBodyWhenReady(cssUrl, ".text-3xl");
    expect(css).toContain(".text-3xl");
  }),
  { timeout: 180_000 },
);

test(
  "serves the SSG about page at its extensionless url",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(`${url}/about`, "prerendered");
    expect(html).toContain("About");
  }),
  { timeout: 180_000 },
);

test(
  "SSR page renders the backend value (value-form createClient)",
  Effect.gen(function* () {
    const url = yield* base;

    // The RSC page called `backend.visits()` — in-process dispatch through
    // the value form — so the KV-backed count is already in the
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
  "queue leg: enqueue → consumer on the same class → processed",
  Effect.gen(function* () {
    const url = yield* base;
    const marker = `queue-marker-${crypto.randomUUID()}`;

    // Baseline first — a rerun against a kept deployment (NO_DESTROY) may
    // already have processed messages.
    const before = yield* readCount(url, "processed-count");

    const sent = yield* getWhenReady(`${url}/api/enqueue?m=${marker}`);
    expect(sent.status).toBe(200);

    // Poll until the consumer's KV writes are observed.
    const client = yield* HttpClient.HttpClient;
    const last = yield* Effect.gen(function* () {
      const kv = yield* client.get(`${url}/api/kv?key=processed-last`);
      return ((yield* kv.json) as { value: string | null }).value;
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (value) => value === marker,
        times: 30,
      }),
    );
    expect(last).toBe(marker);

    // The SSR page renders the consumer state through the value form too.
    const after = yield* readCount(url, "processed-count");
    expect(after).toBeGreaterThan(before);
  }),
  { timeout: 180_000 },
);

test(
  "the mount: /healthz answered in the middleware, ahead of both worlds",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("ok");
  }),
  { timeout: 180_000 },
);

test(
  "the mount: the admin gate runs ahead of the effect fetch",
  Effect.gen(function* () {
    const url = yield* base;
    // Warm first so the cold-start window can't masquerade as the gate.
    yield* getWhenReady(`${url}/healthz`);

    const client = yield* HttpClient.HttpClient;
    // No key → the mount's gate answers before either world.
    const denied = yield* client.get(`${url}/api/admin/secret`);
    expect(denied.status).toBe(403);
    expect(yield* denied.text).toBe("forbidden");

    // With the key the gate passes and the EFFECT fetch answers.
    const passed = yield* client.execute(
      HttpClientRequest.get(`${url}/api/admin/secret`).pipe(
        HttpClientRequest.setHeader("x-admin-key", "letmein"),
      ),
    );
    expect(passed.status).toBe(200);
    expect((yield* passed.json) as object).toEqual({ admin: true });

    // Inside /api/* the effect fetch is authoritative — its own 404
    // (empty body), never waku's page.
    const missed = yield* client.execute(
      HttpClientRequest.get(`${url}/api/admin/anything`).pipe(
        HttpClientRequest.setHeader("x-admin-key", "letmein"),
      ),
    );
    expect(missed.status).toBe(404);
    expect(yield* missed.text).not.toContain("<html");
  }),
  { timeout: 180_000 },
);

test(
  "durable object: same name routes to the same instance (monotonic)",
  Effect.gen(function* () {
    const url = yield* base;
    const name = `it-${crypto.randomUUID().slice(0, 8)}`;

    const first = yield* getWhenReady(`${url}/api/do/increment?name=${name}`);
    expect(first.status).toBe(200);
    const a = ((yield* first.json) as { next: number }).next;

    const second = yield* getWhenReady(`${url}/api/do/increment?name=${name}`);
    const b = ((yield* second.json) as { next: number }).next;
    expect(b).toBe(a + 1);
  }),
  { timeout: 180_000 },
);

test(
  "durable object: streaming RPC forwarded onto a streaming response",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/api/do/ticks?n=4`);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("0\n1\n2\n3\n");
  }),
  { timeout: 180_000 },
);

test(
  "request-scope finalizer runs and lands the KV marker",
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
  "workflow: durable steps run to completion and land the KV marker",
  Effect.gen(function* () {
    const url = yield* base;
    const marker = `wf-${crypto.randomUUID().slice(0, 8)}`;

    const started = yield* getWhenReady(
      `${url}/api/workflow/start?marker=${marker}`,
    );
    expect(started.status).toBe(200);
    const { id } = (yield* started.json) as { id: string };
    expect(id).toBeString();

    const client = yield* HttpClient.HttpClient;
    const status = yield* Effect.gen(function* () {
      const res = yield* client.get(`${url}/api/workflow/status?id=${id}`);
      // A just-created instance (or a propagation-window response) can
      // serialize as null — treat it as "not yet" and keep polling.
      return (yield* res.json) as { status: string } | null;
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (s) => s?.status === "complete" || s?.status === "errored",
        times: 45,
      }),
    );
    expect(status?.status).toBe("complete");

    const kv = yield* client.get(`${url}/api/kv?key=workflow-last`);
    const { value } = (yield* kv.json) as { value: string | null };
    expect(value).toBe(`report:${marker}`);
  }),
  { timeout: 240_000 },
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
