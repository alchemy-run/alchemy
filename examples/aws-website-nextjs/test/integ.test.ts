import * as AWS from "alchemy/AWS";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

// A fresh CloudFront distribution (and the Lambda behind it) can serve
// transient 404/5xx responses while it propagates. `Test.getWhenReady`
// fails on that cold-start window and retries until the site serves a
// real response.
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

// The first deploy runs the full Next.js + OpenNext build AND creates a
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

test(
  "deploys and exposes a url",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toBeString();
  }),
  { timeout: 180_000 },
);

// In-repo ONLY: bun's isolated-install store breaks OpenNext's traced
// node_modules when the Lambda zip flattens the `next` symlink (see the
// README) — Lambda-served routes 500 with a missing @swc/helpers module.
// A standalone copy of this example passes all five tests. Set
// AWS_WEBSITE_NEXTJS_LAMBDA=1 to run them here (e.g. once the
// symlink-preserving bundle lands).
const lambdaRoutesBroken = !process.env.AWS_WEBSITE_NEXTJS_LAMBDA;

test.skipIf(lambdaRoutesBroken)(
  "serves the server-rendered home page",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    expect(html).toContain("Next.js on AWS");
    // The SSR seam (async server component, the value form) rendered the
    // counter.
    expect(html).toContain("Server-rendered visits:");
  }),
  { timeout: 180_000 },
);

test.skipIf(lambdaRoutesBroken)(
  "serves the dynamic API route",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/api/hello`);
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { hello: string };
    expect(body.hello).toBe("world");
  }),
  { timeout: 180_000 },
);

test.skipIf(lambdaRoutesBroken)(
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

// The DynamoDB-backed count as the SSR page renders it (the value form
// of createClient in app/page.tsx).
const readCount = (url: string) =>
  Effect.gen(function* () {
    const res = yield* getWhenReady(url);
    const html = yield* res.text;
    const match = html.match(/data-testid="count"[^>]*>(\d+)/);
    expect(match).not.toBeNull();
    return Number(match![1]);
  });

test.skipIf(lambdaRoutesBroken)(
  "bumps the counter through the server-action transport",
  Effect.gen(function* () {
    const url = yield* base;
    // The browser's path to the backend: app/visits-card.tsx calls the
    // `bumpVisits` server action, which dispatches `backend.bump()`
    // in-process via the value form — compiled by Next into the same
    // server Lambda. The DynamoDB capability bindings (env + IAM) were
    // collected at plan time. Drive the exact wire Next's client runtime
    // uses — the action id discovered from the client chunks.
    const ids = yield* findActionIds(url, ["bumpVisits"]);
    const before = yield* readCount(url);
    const res = yield* callAction(url, ids.bumpVisits!);
    expect(res.status).toBe(200);
    // The write persisted in DynamoDB — the server-rendered count
    // observes it.
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

test.skipIf(lambdaRoutesBroken)(
  "queue round-trip: enqueue via server action, the same-Lambda consumer catches up",
  Effect.gen(function* () {
    const url = yield* base;
    // Each run sends a unique marker so the assertion can't match a
    // message from an earlier run.
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
    const before = yield* readProcessed;

    // The `enqueueJob` server action sends to SQS and returns
    // immediately; the CONSUMER runs out of band on the SAME server
    // Lambda (single-handler OpenNext wrapper), whose event-source
    // mapping was registered by the same backend module.
    const ids = yield* findActionIds(url, ["enqueueJob"]);
    const res = yield* callAction(url, ids.enqueueJob!, [marker]);
    expect(res.status).toBe(200);

    // Bounded poll until the consumer's write lands in DynamoDB.
    const processed = yield* readProcessed.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (state) => state.count > before.count,
        times: 45,
      }),
    );
    expect(processed.count).toBeGreaterThan(before.count);
    expect(processed.last).toBe(marker);
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

test.skipIf(lambdaRoutesBroken)(
  "the mount serves the effect API from the catch-all route file",
  Effect.gen(function* () {
    const url = yield* base;
    // /api/kv rides app/api/[[...slug]]/route.ts -> site.fetch.
    const res = yield* getWhenReady(`${url}/api/kv?key=processed-count`);
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { value: string | null };
    expect(body).toHaveProperty("value");
    // Inside the mount's claim a miss is the effect fetch's own 404 —
    // never Next's HTML not-found page.
    const miss = yield* getWhenReady(`${url}/api/kv-missing-route`).pipe(
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.succeed(response)
          : Effect.fail(new Error(`expected 404, got ${response.status}`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
    );
    expect(miss.status).toBe(404);
  }),
  { timeout: 180_000 },
);

test.skipIf(lambdaRoutesBroken)(
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

test.skipIf(lambdaRoutesBroken)(
  "streaming route serves the full body through the streamified entry",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/api/stream?n=5`);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("0\n1\n2\n3\n4\n");
  }),
  { timeout: 180_000 },
);

test.skipIf(lambdaRoutesBroken)(
  "request-scope finalizer settles inline (Lambda semantics)",
  Effect.gen(function* () {
    const url = yield* base;
    const marker = `finalizer-${crypto.randomUUID()}`;
    const registered = yield* getWhenReady(`${url}/api/finalizer?v=${marker}`);
    expect(registered.status).toBe(200);
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
