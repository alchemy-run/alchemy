import * as Cloudflare from "alchemy/Cloudflare";
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

// Fresh `workers.dev` URLs transiently 404 while the route propagates.
// `HttpClient.execute`/`get` resolve successfully on that 404, so a plain
// `Effect.retry` never fires — these helpers fail on the cold-start window and
// retry until the real response comes back.
const { executeWhenReady, getWhenReady } = Test;

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// While the static-asset manifest is still propagating, requests can serve a
// stale or placeholder body with a 200 — the status alone can't distinguish
// "not yet" from "served", so retry until the body matches.
const getBodyWhenReady = Effect.fn(function* (url: string, expected: string) {
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

const stack = beforeAll(deploy(Stack).pipe(Effect.tap(Console.log)));
afterAll(
  Effect.gen(function* () {
    if (!process.env.NO_DESTROY) {
      yield* destroy(Stack);
    }
  }),
);

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
    );
    if (data !== undefined) {
      const payload = yield* Effect.promise(() => toJSONAsync({ data }));
      request = request.pipe(
        HttpClientRequest.bodyText(
          JSON.stringify(payload),
          "application/json",
        ),
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
  "SSR loader renders the backend value into the HTML",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");

    // The loader called `getVisits()` — the server function dispatches
    // `backend.visits()` through the value form (direct in-process
    // dispatch) — so the KV-backed count is already in the
    // server-rendered HTML.
    const html = yield* getBodyWhenReady(base, "Server-rendered visits:");
    expect(html).toContain("Server-rendered visits:");
    const count = html.match(/data-testid="count"[^>]*>(?:<!--[^>]*-->)?\s*(\d+)/);
    expect(count).not.toBeNull();
    expect(Number(count![1])).toBeGreaterThanOrEqual(0);
    // The queue section's initial state is server-rendered the same way
    // (the loader calls `getProcessed()`).
    expect(html).toContain("Queue-processed:");
  }),
  { timeout: 180_000 },
);

test(
  "bump server function round-trips through KV (Start's transport)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");

    const before = yield* readCount(base, "count");

    // The transport-level proof: POST the compiled `bumpVisits` server
    // function exactly as the browser client would.
    const bumped = yield* callServerFn(base, "bumpVisits");
    expect(bumped.status).toBe(200);

    // The write is visible to the next server render.
    const after = yield* readCount(base, "count").pipe(
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
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");
    const marker = `queue-marker-${crypto.randomUUID()}`;

    // Baseline first — a rerun against a kept deployment (NO_DESTROY) may
    // already have processed messages.
    const before = yield* readCount(base, "processed-count");

    // Produce through the `enqueueJob` server function; the queue consumer
    // registered on the SAME class catches up asynchronously.
    const sent = yield* callServerFn(base, "enqueueJob", marker);
    expect(sent.status).toBe(200);

    // Poll the server-rendered page until the consumer's KV writes are
    // observed by the SSR loader.
    const after = yield* readCount(base, "processed-count").pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (count) => count > before,
        times: 30,
      }),
    );
    expect(after).toBeGreaterThan(before);
    const html = yield* getBodyWhenReady(base, "Queue-processed:");
    expect(html).toContain(marker);
  }),
  { timeout: 180_000 },
);

test(
  "the schema-less RPC wire is not publicly served",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");

    // Warm the deployment first so the cold-start 404 window can't be
    // mistaken for the assertion below.
    yield* getBodyWhenReady(base, "Server-rendered visits:");

    // createClient's in-process dispatch has no HTTP surface: the old
    // universal `POST /api/__rpc/<method>` path falls through to the
    // router and answers its not-found page, never an RPC envelope.
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.execute(
      HttpClientRequest.post(`${base}/api/__rpc/bump`).pipe(
        HttpClientRequest.bodyText("[]", "application/json"),
      ),
    );
    expect(res.status).toBe(404);
    const body = yield* res.text;
    expect(body).not.toContain('"value"');
  }),
  { timeout: 180_000 },
);
