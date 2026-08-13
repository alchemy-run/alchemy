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
const getBodyWhenReady = (url: string, expected: string) =>
  Effect.gen(function* () {
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const body = yield* res.text;
    if (!body.includes(expected)) {
      return yield* Effect.fail(new AssetNotReady({ body }));
    }
    return body;
  }).pipe(
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

// The createClient wire protocol served by the same Worker as the frontend —
// src/backend.ts exposes RPC methods (`get`, `save`) backed by R2, dispatched
// at the universal `POST /api/__rpc/<method>` path.
const rpc = (url: string, method: string, args: unknown[]) =>
  executeWhenReady(
    HttpClientRequest.post(`${url}/api/__rpc/${method}`).pipe(
      HttpClientRequest.bodyText(JSON.stringify(args), "application/json"),
    ),
  );

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
  "RPC methods round-trip through R2 (save then get over /api/__rpc)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");

    // The wire-level proof: `POST /api/__rpc/save` with a JSON array of
    // positional args answers the success envelope.
    const saved = yield* rpc(base, "save", ["hello-from-createClient"]);
    expect(saved.status).toBe(200);
    expect(yield* saved.json).toEqual({ value: "hello-from-createClient" });

    const got = yield* rpc(base, "get", []);
    expect(got.status).toBe(200);
    expect(yield* got.json).toEqual({ value: "hello-from-createClient" });
  }),
  { timeout: 180_000 },
);

test(
  "SSR loader renders the backend value into the HTML",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");

    // Seed R2 through the RPC surface, then assert the server-rendered
    // page contains the value — the loader called `backend.get()` via the
    // value form (direct in-process dispatch) during SSR.
    const saved = yield* rpc(base, "save", ["ssr-rendered-message"]);
    expect(saved.status).toBe(200);

    const html = yield* getBodyWhenReady(base, "ssr-rendered-message");
    expect(html).toContain("ssr-rendered-message");
  }),
  { timeout: 180_000 },
);

test(
  "unknown RPC methods answer the typed 404 envelope",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const base = url.replace(/\/+$/, "");

    // Warm the route first (a real RPC 404 is indistinguishable from the
    // cold-start 404 that `executeWhenReady` retries through).
    const warm = yield* rpc(base, "get", []);
    expect(warm.status).toBe(200);

    const client = yield* HttpClient.HttpClient;
    const res = yield* client.execute(
      HttpClientRequest.post(`${base}/api/__rpc/nope`).pipe(
        HttpClientRequest.bodyText("[]", "application/json"),
      ),
    );
    expect(res.status).toBe(404);
    const body = (yield* res.json) as { error: { _tag: string } };
    expect(body.error._tag).toBe("RpcMethodNotFound");
  }),
  { timeout: 180_000 },
);
