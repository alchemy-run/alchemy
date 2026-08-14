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

// One RPC wire call, exactly as `createClient`'s type-only form sends it:
// `POST /api/__rpc/<method>` with a JSON array of positional args.
const rpcWhenReady = (url: string, method: string, args: unknown[] = []) =>
  executeWhenReady(
    HttpClientRequest.post(`${url}/api/__rpc/${method}`).pipe(
      HttpClientRequest.bodyText(JSON.stringify(args), "application/json"),
    ),
  );

class AssetNotReady extends Data.TaggedError("AssetNotReady")<{
  body: string;
}> {}

// While the asset manifest and CloudFront edge caches are still
// propagating, a 200 body can be stale — the status alone can't
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

test.skipIf(lambdaRoutesBroken)(
  "serves the backend methods over the rpc wire path",
  Effect.gen(function* () {
    const url = yield* base;
    // `POST /api/__rpc/bump` is the exact wire request the browser's
    // type-only `createClient<typeof Backend>()` sends. It rides through
    // the catch-all route handler at app/api/[[...slug]]/route.ts
    // (toRouteHandler dispatches the rpc path before route matching),
    // compiled by Next into the same server Lambda. The DynamoDB
    // capability bindings (env + IAM) were collected at plan time.
    const res = yield* rpcWhenReady(url, "bump");
    expect(res.status).toBe(200);
    const body = (yield* res.json) as { value: number };
    expect(body.value).toBeGreaterThanOrEqual(1);
    // A second call increments — the method really runs per request.
    const again = yield* rpcWhenReady(url, "bump");
    const next = (yield* again.json) as { value: number };
    expect(next.value).toBeGreaterThan(body.value);
  }),
  { timeout: 180_000 },
);

test.skipIf(lambdaRoutesBroken)(
  "SSR renders the backend value loaded in-process by the server component",
  Effect.gen(function* () {
    const url = yield* base;
    // The previous test bumped through the wire; the async server
    // component reads the same DynamoDB counter with the VALUE form of
    // createClient (direct in-process dispatch) and renders it.
    const html = yield* getBodyWhenReady(url, "Server-rendered visits:");
    const visits = html.match(/Server-rendered visits:[\s\S]{0,200}?(\d+)/);
    expect(visits).not.toBeNull();
    expect(Number(visits![1])).toBeGreaterThanOrEqual(2);
  }),
  { timeout: 180_000 },
);

test.skipIf(lambdaRoutesBroken)(
  "queue round-trip: enqueue over rpc, the sibling consumer catches up",
  Effect.gen(function* () {
    const url = yield* base;
    // Each run sends a unique marker so the assertion can't match a
    // message from an earlier run.
    const marker = `queue-marker-${crypto.randomUUID()}`;

    const readProcessed = Effect.gen(function* () {
      const res = yield* rpcWhenReady(url, "processed");
      expect(res.status).toBe(200);
      const body = (yield* res.json) as {
        value: { count: number; last: string | null };
      };
      return body.value;
    });
    const before = yield* readProcessed;

    // `POST /api/__rpc/enqueue` sends to SQS and returns immediately;
    // the CONSUMER runs out of band on the sibling effect Lambda
    // (`<site>-Handlers`), whose event-source mapping was registered by
    // the same backend module.
    const res = yield* rpcWhenReady(url, "enqueue", [marker]);
    expect(res.status).toBe(200);

    // Bounded poll until the sibling's write lands in DynamoDB.
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
