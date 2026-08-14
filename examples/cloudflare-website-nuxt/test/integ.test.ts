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

// KNOWN GAP: the value form (direct in-process dispatch) currently fails
// inside the deployed Worker's VUE SERVER graph — nuxt's vite-builder
// resolves the alchemy/effect graph node-flavored, and it breaks on
// workerd ("r.once is not a function", surfaced as a NuxtError in the
// payload), so useAsyncData's server branch yields null and the count is
// not server-rendered. The page catches up client-side via the type-only
// form (not assertable over plain HTTP). Ungate once the entry's
// prebundled effect module is shared with the vue server graph.
test.skipIf(!process.env.CLOUDFLARE_NUXT_SSR_VALUE_FORM)(
  "server-renders the backend value into the home page (value form)",
  Effect.gen(function* () {
    const url = yield* base;
    // app/pages/index.vue calls `backend.visits()` in its useAsyncData
    // server branch through the VALUE form of createClient (direct
    // in-process dispatch) — the KV-backed count is already in the
    // server-rendered HTML.
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
  "the exclusion glob hands /api/hello back to nitro",
  Effect.gen(function* () {
    const url = yield* base;
    // server/backend.ts claims ["/api/*", "!/api/hello"] — exclusions win,
    // so nitro's own route answers /api/hello...
    const body = yield* getBodyWhenReady(`${url}/api/hello`, "from nitro");
    expect(JSON.parse(body)).toEqual({ hello: "from nitro" });

    // ...while every other /api/* path is answered by the program (even
    // its 404s — never nitro).
    const client = yield* HttpClient.HttpClient;
    const owned = yield* client.get(`${url}/api/anything-else`);
    expect(owned.status).toBe(404);
    expect(yield* owned.json).toEqual({ error: "unknown effect route" });
  }),
  { timeout: 180_000 },
);

test(
  "serves the createClient wire protocol (POST /api/__rpc/bump)",
  Effect.gen(function* () {
    const url = yield* base;
    // The wire-level proof of the browser's type-only form: the universal
    // `POST /api/__rpc/<method>` dispatch (checked before `server.routes`)
    // envelope-encodes the RPC method result — backed by the KV binding
    // collected at plan time.
    const bump = Effect.gen(function* () {
      const res = yield* executeWhenReady(
        HttpClientRequest.post(`${url}/api/__rpc/bump`).pipe(
          HttpClientRequest.bodyText("[]", "application/json"),
        ),
      );
      expect(res.status).toBe(200);
      const body = (yield* res.json) as { value: number };
      return body.value;
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

    // Produce through the RPC surface (the entry takeover delivers the
    // queue handler alongside fetch); the consumer registered on the SAME
    // class catches up asynchronously.
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
