import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
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
    // already in the server-rendered HTML.
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
  "serves the createClient wire protocol (POST /api/__rpc/bump)",
  Effect.gen(function* () {
    const url = yield* base;
    // The wire-level proof of the browser's type-only form: the universal
    // `POST /api/__rpc/<method>` dispatch envelope-encodes the RPC method
    // result — backed by the KV binding collected at plan time.
    const res = yield* executeWhenReady(
      HttpClientRequest.post(`${url}/api/__rpc/bump`).pipe(
        HttpClientRequest.bodyText("[]", "application/json"),
      ),
    );
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { value: number };
    expect(body.value).toBeGreaterThanOrEqual(1);
  }),
  { timeout: 180_000 },
);

test(
  "queue leg: enqueue → consumer on the same class → processed",
  Effect.gen(function* () {
    const url = yield* base;
    const marker = `queue-marker-${crypto.randomUUID()}`;

    const readProcessed = Effect.gen(function* () {
      const res = yield* executeWhenReady(
        HttpClientRequest.post(`${url}/api/__rpc/processed`).pipe(
          HttpClientRequest.bodyText("[]", "application/json"),
        ),
      );
      expect(res.status).toBe(200);
      const body = (yield* res.json) as {
        value: { count: number; last: string | null };
      };
      return body.value;
    });

    // Baseline first — a rerun against a kept deployment (NO_DESTROY) may
    // already have processed messages.
    const before = yield* readProcessed;

    // Produce through the RPC surface; the queue consumer registered on
    // the SAME class catches up asynchronously.
    const sent = yield* executeWhenReady(
      HttpClientRequest.post(`${url}/api/__rpc/enqueue`).pipe(
        HttpClientRequest.bodyText(
          JSON.stringify([marker]),
          "application/json",
        ),
      ),
    );
    expect(sent.status).toBe(200);

    // Poll until the consumer's KV writes are observed.
    const after = yield* readProcessed.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (p) => p.count > before.count,
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
