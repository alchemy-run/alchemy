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

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

// The first deploy runs the full Nuxt build, so give the hook more
// headroom than the default 120s.
const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)), {
  timeout: 600_000,
});
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const base = Effect.map(stack, ({ url }) => {
  if (!url) throw new Error("expected the site to expose a workers.dev url");
  return url.replace(/\/+$/, "");
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
  "serves the home page with both demo sections",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    expect(html).toContain("Nuxt on Cloudflare Workers");
    expect(html).toContain("Server-rendered visits:");
    expect(html).toContain("Queue-processed:");
  }),
  { timeout: 180_000 },
);

test(
  "server-renders the backend value into the home page",
  Effect.gen(function* () {
    const url = yield* base;
    // app/pages/index.vue useFetches /api/visits during SSR — nitro runs
    // the route handler in-process inside the Worker (the nitro server
    // graph, where the value form dispatches directly), so the KV-backed
    // count is already in the server-rendered HTML.
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    const count = html.match(/data-testid="count"[^>]*>(\d+)/);
    expect(count).not.toBeNull();
    expect(Number(count![1])).toBeGreaterThanOrEqual(0);
  }),
  { timeout: 180_000 },
);

test(
  "nitro serves its own api routes in the same Worker",
  Effect.gen(function* () {
    const url = yield* base;
    // /api/jobs is nitro's own route calling the effectful backend.
    const body = yield* getBodyWhenReady(`${url}/api/jobs`, "count");
    expect(JSON.parse(body)).toHaveProperty("count");

    // /api/visits dispatches the backend method in-process and answers
    // with the KV-backed count.
    const visits = yield* getWhenReady(`${url}/api/visits`);
    expect(visits.status).toBe(200);
    const value = (yield* visits.json) as { count: number };
    expect(value.count).toBeGreaterThanOrEqual(0);
  }),
  { timeout: 180_000 },
);

test(
  "bumps the counter through the nitro route (POST /api/visits)",
  Effect.gen(function* () {
    const url = yield* base;
    // The exact request the "Bump visits" button sends. The route handler
    // value-imports the backend and calls `bump()` in-process — backed by
    // the KV binding collected at plan time.
    const bump = Effect.gen(function* () {
      const res = yield* postJsonWhenReady(`${url}/api/visits`);
      expect(res.status).toBe(200);
      const body = (yield* res.json) as { count: number };
      return body.count;
    });
    const first = yield* bump;
    expect(first).toBeGreaterThanOrEqual(1);
    // A second bump observes the first write — the counter persists in KV
    // rather than answering a constant.
    const second = yield* bump;
    expect(second).toBeGreaterThanOrEqual(first + 1);
  }),
  { timeout: 180_000 },
);

test(
  "queue leg: enqueue → consumer on the same class → processed",
  Effect.gen(function* () {
    const url = yield* base;
    const marker = `queue-marker-${crypto.randomUUID()}`;

    const readProcessed = Effect.gen(function* () {
      const res = yield* getWhenReady(`${url}/api/jobs`);
      expect(res.status).toBe(200);
      return (yield* res.json) as { count: number; last: string | null };
    });

    // Baseline first — a rerun against a kept deployment (NO_DESTROY) may
    // already have processed messages.
    const before = yield* readProcessed;

    // Produce through the nitro route (the entry takeover delivers the
    // queue handler alongside fetch); the consumer registered on the SAME
    // class catches up asynchronously.
    const sent = yield* postJsonWhenReady(`${url}/api/jobs`, {
      message: marker,
    });
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
  "serves a static asset from public/",
  Effect.gen(function* () {
    const url = yield* base;
    const body = yield* getBodyWhenReady(`${url}/robots.txt`, "User-agent: *");
    expect(body).toContain("User-agent: *");
  }),
  { timeout: 180_000 },
);

// ── MaxSite: the mount (server/middleware/alchemy.ts) + platform legs ──

test(
  "mount: /healthz answered in the middleware, ahead of both worlds",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/healthz`);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("ok");
  }),
  { timeout: 180_000 },
);

test(
  "mount: the admin gate runs ahead of the effect fetch",
  Effect.gen(function* () {
    const url = yield* base;
    yield* getWhenReady(`${url}/healthz`);

    const client = yield* HttpClient.HttpClient;
    // A redeploy serves the previous version for a short window on
    // workers.dev — poll (bounded) until the NEW dispatch order answers.
    const observed = yield* Effect.gen(function* () {
      const denied = yield* client.get(`${url}/api/admin/anything`);
      const passed = yield* client.execute(
        HttpClientRequest.get(`${url}/api/admin/anything`).pipe(
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
    // own 404 (empty body), never nitro's error page.
    expect(observed.passed).toBe(404);
    expect(observed.passedBody).not.toContain("<html");
  }),
  { timeout: 180_000 },
);

test(
  "mount: the exclusion glob carves nitro's own /api/jobs back out",
  Effect.gen(function* () {
    const url = yield* base;
    // Served by nitro's server/api/jobs.get.ts (through createClient), NOT
    // the effect fetch — proof the mount's routes claim is the user's
    // decision.
    const res = yield* getWhenReady(`${url}/api/jobs`);
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { count: number };
    expect(body.count).toBeGreaterThanOrEqual(0);
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
  "request-scope finalizer runs after the response (waitUntil settle)",
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

    const client = yield* HttpClient.HttpClient;
    const status = yield* Effect.gen(function* () {
      const res = yield* client.get(`${url}/api/workflow/status?id=${id}`);
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
