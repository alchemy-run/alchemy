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

// Discover the production ids of named server actions: the page's client
// chunks carry `createServerReference("<id>", …, "<exportedName>")` for
// every action the client components import from app/actions.ts.
const findActionIds = Effect.fn(function* (base: string, names: string[]) {
  const page = yield* getWhenReady(base);
  const html = yield* page.text;
  const chunks = [
    ...new Set(
      [...html.matchAll(/(?:\/_next\/)?static\/chunks\/[\w.[\]%-]+\.js/g)].map(
        (m) => (m[0].startsWith("/_next/") ? m[0] : `/_next/${m[0]}`),
      ),
    ),
  ];
  const ids: Record<string, string> = {};
  for (const chunk of chunks) {
    const res = yield* getWhenReady(`${base}${chunk}`);
    const js = yield* res.text;
    for (const match of js.matchAll(
      /createServerReference\)?\("([0-9a-f]{40,})"[^)]*?"(\w+)"\)/g,
    )) {
      ids[match[2]!] = match[1]!;
    }
  }
  for (const name of names) {
    if (!ids[name]) throw new Error(`no server action id found for ${name}`);
  }
  return ids;
});

// One server-action call, exactly as Next's client runtime sends it:
// POST to the page with the `Next-Action` header and a JSON array of
// positional args (the `origin` header satisfies Next's CSRF check).
const callAction = (base: string, id: string, args: unknown[] = []) =>
  executeWhenReady(
    HttpClientRequest.post(`${base}/`).pipe(
      HttpClientRequest.setHeaders({
        "next-action": id,
        origin: base,
        accept: "text/x-component",
      }),
      HttpClientRequest.bodyText(
        JSON.stringify(args),
        "text/plain;charset=UTF-8",
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

// The first deploy runs the full Next.js + OpenNext build, so give the hook
// more headroom than the default 120s.
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
    // app/page.tsx (an async server component) calls `backend.visits()`
    // through the VALUE form of createClient (direct in-process dispatch)
    // — the KV-backed count is already in the server-rendered HTML.
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    expect(html).toContain("Next.js on Cloudflare Workers");
    expect(html).toContain("Server-rendered visits:");
    const count = html.match(/data-testid="count"[^>]*>(\d+)/);
    expect(count).not.toBeNull();
    expect(Number(count![1])).toBeGreaterThanOrEqual(0);
    // The queue section's initial state is server-rendered the same way
    // (the value form calls `backend.processed()` in app/page.tsx).
    expect(html).toContain("Queue-processed:");
  }),
  { timeout: 180_000 },
);

test(
  "serves the dynamic API route",
  Effect.gen(function* () {
    const url = yield* base;
    // Next's own App Router route handler, calling the effectful backend
    // through the module-scope value-form client — the backend claims no
    // HTTP paths, so all of /api/* stays Next's.
    const res = yield* getWhenReady(`${url}/api/jobs`);
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { count: number };
    expect(body.count).toBeGreaterThanOrEqual(0);
  }),
  { timeout: 180_000 },
);

// The KV-backed count as the SSR page renders it (the value form of
// createClient in app/page.tsx).
const readCount = (url: string) =>
  Effect.gen(function* () {
    const res = yield* getWhenReady(url);
    const html = yield* res.text;
    const match = html.match(/data-testid="count"[^>]*>(\d+)/);
    expect(match).not.toBeNull();
    return Number(match![1]);
  });

test(
  "bumps the counter through the server-action transport",
  Effect.gen(function* () {
    const url = yield* base;
    // The browser's path to the backend: app/visits-card.tsx calls the
    // `bumpVisits` server action, which dispatches `backend.bump()`
    // in-process via the value form. Drive the exact wire Next's client
    // runtime uses — the action id discovered from the client chunks.
    const ids = yield* findActionIds(url, ["bumpVisits"]);
    const before = yield* readCount(url);
    const res = yield* callAction(url, ids.bumpVisits!);
    expect(res.status).toBe(200);
    // The write persisted in KV — the server-rendered count observes it.
    const after = yield* readCount(url).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (count) => count > before,
        times: 15,
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

    // The consumer's state as the SSR page renders it (the value form
    // calls `backend.processed()` in app/page.tsx).
    const readProcessed = Effect.gen(function* () {
      const res = yield* getWhenReady(url);
      const html = yield* res.text;
      const count = html.match(/data-testid="processed-count"[^>]*>(\d+)/);
      const last = html.match(/data-testid="processed-last"[^>]*>([^<]*)</);
      expect(count).not.toBeNull();
      return { count: Number(count![1]), last: last?.[1] ?? null };
    });

    // Baseline first — a rerun against a kept deployment (NO_DESTROY) may
    // already have processed messages.
    const before = yield* readProcessed;

    // Produce through the `enqueueJob` server action (the entry takeover
    // wraps the OpenNext artifact so the queue handler is delivered
    // alongside fetch); the consumer registered on the SAME class catches
    // up asynchronously.
    const ids = yield* findActionIds(url, ["enqueueJob"]);
    const sent = yield* callAction(url, ids.enqueueJob!, [marker]);
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
  "compiles tailwind via postcss",
  Effect.gen(function* () {
    const url = yield* base;
    // The page markup uses Tailwind utilities — proving the project's own
    // postcss.config.mjs (@tailwindcss/postcss) ran inside `next build`.
    const html = yield* getBodyWhenReady(url, "text-3xl");
    expect(html).toContain("text-3xl");

    // Next.js links the compiled stylesheet from under /_next/static/
    // (chunks/*.css as of Next 16).
    const match = html.match(/\/_next\/static\/[^"']+\.css/);
    expect(match).not.toBeNull();

    // The stylesheet must contain the compiled Tailwind rule, not just the
    // class name in markup.
    const css = yield* getBodyWhenReady(`${url}${match![0]}`, ".text-3xl");
    expect(css).toContain(".text-3xl");
    expect(css).toContain(".font-bold");
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
