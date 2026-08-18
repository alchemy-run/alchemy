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

// One HttpApi call, exactly as the browser's `HttpApiClient` (built from
// src/api.ts alone) sends it: plain JSON over the schema's paths.
const postWhenReady = (url: string, body?: unknown) =>
  executeWhenReady(
    body === undefined
      ? HttpClientRequest.post(url)
      : HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
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

// The first deploy runs the Vite build AND creates a CloudFront
// distribution (~5-10 minutes), so give the hook far more headroom than
// the default 120s.
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
    const { url, serverUrl } = yield* stack;
    expect(url).toBeString();
    expect(serverUrl).toBeString();
  }),
  { timeout: 180_000 },
);

test(
  "serves the SPA shell",
  Effect.gen(function* () {
    const url = yield* base;
    const html = yield* getBodyWhenReady(url, '<div id="root">');
    expect(html).toContain("AWS Vite Example");
  }),
  { timeout: 180_000 },
);

test(
  "serves the HttpApi endpoints from the effect Lambda behind /api/*",
  Effect.gen(function* () {
    const url = yield* base;
    // GET /api/visits — the schema's read endpoint, served by the effect
    // fetch through the CloudFront edge router (server routes win over the
    // asset manifest even under `spa: true`).
    const visits = yield* getWhenReady(`${url}/api/visits`);
    expect(visits.status).toBe(200);
    const before = (yield* visits.json) as { count: number };
    expect(before.count).toBeGreaterThanOrEqual(0);

    // POST /api/visits/bump increments — the S3 capability bindings
    // (env + IAM) were collected from the program at plan time.
    const bumped = yield* postWhenReady(`${url}/api/visits/bump`);
    expect(bumped.status).toBe(200);
    const first = (yield* bumped.json) as { count: number };
    expect(first.count).toBeGreaterThan(before.count);

    // A second call increments again — the method really runs per request.
    const again = yield* postWhenReady(`${url}/api/visits/bump`);
    const second = (yield* again.json) as { count: number };
    expect(second.count).toBeGreaterThan(first.count);
  }),
  { timeout: 180_000 },
);

test(
  "schema validation answers a bad enqueue payload with a 400",
  Effect.gen(function* () {
    const url = yield* base;
    // `message` is Schema.NonEmptyString — an empty message must be
    // rejected by the HttpApi decode step before any handler runs.
    const res = yield* postWhenReady(`${url}/api/queue`, { message: "" });
    expect(res.status).toBe(400);
  }),
  { timeout: 180_000 },
);

test(
  "queue round-trip: enqueue over the HttpApi, the consumer catches up",
  Effect.gen(function* () {
    const url = yield* base;
    // Each run sends a unique marker so the assertion can't match a
    // message from an earlier run.
    const marker = `queue-marker-${crypto.randomUUID()}`;

    const readProcessed = Effect.gen(function* () {
      const res = yield* getWhenReady(`${url}/api/queue/processed`);
      expect(res.status).toBe(200);
      return (yield* res.json) as { count: number; last: string | null };
    });
    const before = yield* readProcessed;

    // `POST /api/queue` sends to SQS and returns immediately; the CONSUMER
    // runs out of band on the site's own effect Lambda, whose event-source
    // mapping was registered by the same backend module.
    const res = yield* postWhenReady(`${url}/api/queue`, { message: marker });
    expect(res.status).toBe(200);

    // Bounded poll until the consumer's write lands in the bucket.
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
  "streaming route serves the full body through the effect entry",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(`${url}/api/stream?n=5`);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("0\n1\n2\n3\n4\n");
  }),
  { timeout: 180_000 },
);

test(
  "request-scope finalizer settles inline (Lambda semantics)",
  Effect.gen(function* () {
    const url = yield* base;
    const marker = `finalizer-${crypto.randomUUID()}`;
    const registered = yield* getWhenReady(`${url}/api/finalizer?v=${marker}`);
    expect(registered.status).toBe(200);
    // Inline settle: the S3 write happened BEFORE the response resolved.
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
