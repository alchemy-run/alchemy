import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Schedule from "effect/Schedule";
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

// The browser's transport is Astro Actions: `POST /_actions/<name>` with a
// JSON input body. Successful results come back devalue-encoded
// (`application/json+devalue`), a flat array whose index 0 is the root.
const action = (url: string, name: string, input?: unknown) =>
  executeWhenReady(
    HttpClientRequest.post(`${url}/_actions/${name}`).pipe(
      HttpClientRequest.bodyText(
        JSON.stringify(input ?? {}),
        "application/json",
      ),
    ),
  );

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

// The first deploy runs the full Astro build, so give the hook more headroom
// than the default 120s.
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
  "server-renders the backend value into the home page (value form)",
  Effect.gen(function* () {
    const url = yield* base;
    // The frontmatter calls `backend.visits()` through the VALUE form of
    // createClient (direct in-process dispatch) — the KV-backed count is
    // in the server-rendered HTML of the React island.
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    expect(html).toContain("Server-rendered visits:");
    const count = html.match(/data-testid="count"[^>]*>(\d+)</);
    expect(count).not.toBeNull();
    expect(Number(count![1])).toBeGreaterThanOrEqual(0);
    // The queue section's initial state is server-rendered the same way
    // (the value form calls `backend.processed()` in the frontmatter).
    expect(html).toContain("Queue-processed:");
  }),
  { timeout: 180_000 },
);

test(
  "the bump action dispatches the backend method (Astro Actions)",
  Effect.gen(function* () {
    const url = yield* base;
    // The exact request the React island's `actions.bump()` sends: the
    // action handler calls the backend's `bump()` in-process (the value
    // form) — backed by the KV binding collected at plan time.
    const bump = Effect.gen(function* () {
      const res = yield* action(url, "bump");
      expect(res.status).toBe(200);
      const [count] = JSON.parse(yield* res.text) as [number];
      return count;
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
  "queue leg: enqueue action → consumer on the same class → processed",
  Effect.gen(function* () {
    const url = yield* base;
    const marker = `queue-marker-${crypto.randomUUID()}`;

    const readProcessed = Effect.gen(function* () {
      const res = yield* action(url, "processed");
      expect(res.status).toBe(200);
      // Devalue-decode the `{ count, last }` object: index 0 holds the
      // root's field → index mapping.
      const arr = JSON.parse(yield* res.text) as unknown[];
      const root = arr[0] as { count: number; last: number };
      return {
        count: arr[root.count] as number,
        last: arr[root.last] as string | null,
      };
    });

    // Baseline first — a rerun against a kept deployment (NO_DESTROY) may
    // already have processed messages.
    const before = yield* readProcessed;

    // Produce through the enqueue action; the queue consumer registered
    // on the SAME class catches up asynchronously. A void handler result
    // answers 204.
    const sent = yield* action(url, "enqueue", { message: marker });
    expect(sent.status).toBe(204);

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
    const res = yield* getWhenReady(`${url}/about/`);
    expect(res.status).toBe(200);
  }),
  { timeout: 180_000 },
);

test(
  "compiles tailwind from astro.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    // The utility class in the markup proves the page shipped with Tailwind
    // classes; wait until the deployed HTML includes it.
    const html = yield* getBodyWhenReady(url, "text-3xl");

    // Astro either links an external compiled stylesheet or inlines small
    // ones as a <style> block — accept both, but the compiled rule for the
    // utility must be served either way. That rule only exists if the
    // @tailwindcss/vite plugin from the project's own astro.config.ts ran.
    const link = html.match(
      /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/,
    );
    if (link) {
      const href = link[1]!;
      const cssUrl = href.startsWith("http")
        ? href
        : `${url}${href.startsWith("/") ? "" : "/"}${href}`;
      const css = yield* getBodyWhenReady(cssUrl, ".text-3xl");
      expect(css).toContain(".text-3xl");
    } else {
      const style = html.match(/<style[^>]*>([\s\S]*?)<\/style>/);
      expect(style).not.toBeNull();
      expect(style![1]).toContain(".text-3xl");
    }
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
  "mount: /healthz answered in the fetch entry, ahead of both worlds",
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
