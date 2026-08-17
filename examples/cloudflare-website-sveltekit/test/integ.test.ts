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
const { executeWhenReady, getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// While the static-asset manifest is still propagating, Cloudflare serves a
// managed "content signals" robots.txt with a 200 — the status alone can't
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

// One SvelteKit form-action POST, exactly as `use:enhance` submits it:
// urlencoded body, `x-sveltekit-action` for a JSON ActionResult, and a
// matching `origin` for kit's CSRF check.
const actionWhenReady = (url: string, action: string, body = "") =>
  executeWhenReady(
    HttpClientRequest.post(`${url}/?/${action}`).pipe(
      HttpClientRequest.setHeaders({
        origin: new URL(url).origin,
        "x-sveltekit-action": "true",
      }),
      HttpClientRequest.bodyText(body, "application/x-www-form-urlencoded"),
    ),
  );

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

// The first deploy runs the full SvelteKit build, so give the hook more
// headroom than the default 120s.
const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
  timeout: 600_000,
});
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a workers.dev url");
  return url.replace(/\/+$/, "");
});

// Read the server-rendered visits count out of the home page HTML. Svelte 5
// SSR may emit hydration comment anchors around the text, so match the first
// digits after the element opening tag.
const readCount = (url: string) =>
  Effect.gen(function* () {
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    const count = html.match(/data-testid="count"[^>]*>(?:<!---->)?\s*(\d+)/);
    expect(count).not.toBeNull();
    return Number(count![1]);
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
  "server-renders the backend value into the home page (value form)",
  Effect.gen(function* () {
    const url = yield* base;
    // +page.server.ts calls `backend.visits()` through the VALUE form of
    // createClient (direct in-process dispatch) — the KV-backed count is
    // already in the server-rendered HTML.
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    expect(html).toContain("SvelteKit on Cloudflare Workers");
    expect(html).toContain("Server-rendered visits:");
    const count = yield* readCount(url);
    expect(count).toBeGreaterThanOrEqual(0);
    // The queue section's initial state is server-rendered the same way
    // (the value form calls `backend.processed()` in +page.server.ts).
    expect(html).toContain("Queue-processed:");
  }),
  { timeout: 180_000 },
);

test(
  "the bump form action is the public write surface",
  Effect.gen(function* () {
    const url = yield* base;
    const before = yield* readCount(url);
    // POST `/?/bump` is the exact request `use:enhance` sends — the action
    // calls `backend.bump()` in-process (value form) inside the Worker.
    const res = yield* actionWhenReady(url, "bump");
    expect(res.status).toBe(200);
    const result = (yield* res.json) as { type: string };
    expect(result.type).toBe("success");
    // The write landed in KV: the server-rendered count reflects it (KV
    // reads can lag a moment, so poll).
    const after = yield* readCount(url).pipe(
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
  "queue leg: enqueue action → consumer on the same class → /api/processed",
  Effect.gen(function* () {
    const url = yield* base;
    const marker = `queue-marker-${crypto.randomUUID()}`;

    // The JSON route the page polls — a plain framework API route backed
    // by the value-form client.
    const readProcessed = Effect.gen(function* () {
      const res = yield* getWhenReady(`${url}/api/processed`);
      expect(res.status).toBe(200);
      return (yield* res.json) as { count: number; last: string | null };
    });

    // Baseline first — a rerun against a kept deployment (NO_DESTROY) may
    // already have processed messages.
    const before = yield* readProcessed;

    // Produce through the enqueue form action; the queue consumer
    // registered on the SAME class catches up asynchronously.
    const sent = yield* actionWhenReady(
      url,
      "enqueue",
      `message=${encodeURIComponent(marker)}`,
    );
    expect(sent.status).toBe(200);

    // Poll until the consumer's KV writes are observed.
    const after = yield* readProcessed.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        // Both keys must land: the consumer writes count THEN last as
        // separate KV puts, and KV propagates them independently — waiting
        // on count alone races the gap and reads a stale/absent last.
        until: (p) => p.count > before.count && p.last === marker,
        times: 30,
      }),
    );
    expect(after.count).toBeGreaterThan(before.count);
    expect(after.last).toBe(marker);
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
  "compiles tailwind from vite.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    // The page markup uses Tailwind utilities...
    expect(html).toContain("text-3xl");
    // ...and links the stylesheet Vite emitted via the project-owned
    // vite.config.ts (the @tailwindcss/vite plugin), proving Alchemy loaded
    // the config file natively instead of the programmatic fallback.
    const match = html.match(/\/_app\/immutable\/assets\/[^"']+\.css/);
    expect(match).not.toBeNull();
    const css = yield* getBodyWhenReady(`${url}${match![0]}`, ".text-3xl");
    expect(css).toContain(".text-3xl");
    expect(css).toContain(".font-bold");
  }),
  { timeout: 180_000 },
);

test(
  "serves a static asset from static/",
  Effect.gen(function* () {
    const url = yield* base;
    const body = yield* getBodyWhenReady(`${url}/robots.txt`, "User-agent: *");
    expect(body).toContain("User-agent: *");
  }),
  { timeout: 180_000 },
);

test(
  "mount: /healthz answered in the hook, ahead of both worlds",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    const base = url.replace(/\/+$/, "");
    const res = yield* getWhenReady(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("ok");
  }),
  { timeout: 180_000 },
);

test(
  "mount: the admin gate runs ahead of the effect fetch",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    const base = url.replace(/\/+$/, "");
    yield* getWhenReady(`${base}/healthz`);

    const client = yield* HttpClient.HttpClient;
    // A redeploy serves the previous version for a short window on
    // workers.dev — poll (bounded) until the NEW dispatch order answers.
    const observed = yield* Effect.gen(function* () {
      const denied = yield* client.get(`${base}/api/admin/anything`);
      const passed = yield* client.execute(
        HttpClientRequest.get(`${base}/api/admin/anything`).pipe(
          HttpClientRequest.setHeader("x-admin-key", "letmein"),
        ),
      );
      return {
        denied: denied.status,
        passed: passed.status,
        passedBody: yield* passed.text,
      };
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (o) => o.denied === 403 && o.passed === 404,
        times: 30,
      }),
    );
    expect(observed.denied).toBe(403);
    // Gate passed -> the effect fetch is authoritative for /api/* — its
    // own 404 (empty body), never kit's HTML error page.
    expect(observed.passed).toBe(404);
    expect(observed.passedBody).not.toContain("<html");
  }),
  { timeout: 180_000 },
);

test(
  "mount: the exclusion glob carves kit's own /api/processed back out",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    const base = url.replace(/\/+$/, "");
    // Served by kit's +server.ts (through createClient), NOT the effect
    // fetch — proof the mount's routes claim is the user's decision.
    const res = yield* getWhenReady(`${base}/api/processed`);
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { count: number };
    expect(body.count).toBeGreaterThanOrEqual(0);
  }),
  { timeout: 180_000 },
);

test(
  "durable object: same name routes to the same instance (monotonic)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    const base = url.replace(/\/+$/, "");
    const name = `it-${crypto.randomUUID().slice(0, 8)}`;

    const first = yield* getWhenReady(`${base}/api/do/increment?name=${name}`);
    expect(first.status).toBe(200);
    const a = ((yield* first.json) as { next: number }).next;
    const second = yield* getWhenReady(`${base}/api/do/increment?name=${name}`);
    const b = ((yield* second.json) as { next: number }).next;
    expect(b).toBe(a + 1);
  }),
  { timeout: 180_000 },
);

test(
  "durable object: streaming RPC forwarded onto a streaming response",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    const base = url.replace(/\/+$/, "");
    const res = yield* getWhenReady(`${base}/api/do/ticks?n=4`);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("0\n1\n2\n3\n");
  }),
  { timeout: 180_000 },
);

test(
  "request-scope finalizer runs after the response (waitUntil settle)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    const base = url.replace(/\/+$/, "");
    const marker = `fin-${crypto.randomUUID().slice(0, 8)}`;

    const res = yield* getWhenReady(`${base}/api/finalizer?v=${marker}`);
    expect(res.status).toBe(200);

    const client = yield* HttpClient.HttpClient;
    const value = yield* Effect.gen(function* () {
      const kv = yield* client.get(`${base}/api/kv?key=finalizer-last`);
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
    const { url } = yield* stack;
    if (typeof url !== "string") throw new Error("no url output");
    const base = url.replace(/\/+$/, "");
    const marker = `wf-${crypto.randomUUID().slice(0, 8)}`;

    const started = yield* getWhenReady(
      `${base}/api/workflow/start?marker=${marker}`,
    );
    expect(started.status).toBe(200);
    const { id } = (yield* started.json) as { id: string };

    const client = yield* HttpClient.HttpClient;
    const status = yield* Effect.gen(function* () {
      const res = yield* client.get(`${base}/api/workflow/status?id=${id}`);
      return (yield* res.json) as { status: string } | null;
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (s) => s?.status === "complete" || s?.status === "errored",
        times: 45,
      }),
    );
    expect(status?.status).toBe("complete");

    const kv = yield* client.get(`${base}/api/kv?key=workflow-last`);
    const { value } = (yield* kv.json) as { value: string | null };
    expect(value).toBe(`report:${marker}`);
  }),
  { timeout: 240_000 },
);
