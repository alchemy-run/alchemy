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

// One SvelteKit form-action POST, exactly as `use:enhance` submits it:
// urlencoded body, `x-sveltekit-action` for a JSON ActionResult, and a
// matching `origin` for kit's CSRF check.
const actionWhenReady = (url: string, action: string, body = "") =>
  executeWhenReady(
    HttpClientRequest.post(`${url}/?/${action}`).pipe(
      HttpClientRequest.setHeaders({
        origin: new URL(url).origin,
        "x-sveltekit-action": "true",
      }),
      HttpClientRequest.bodyText(body, "application/x-www-form-urlencoded"),
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

// The first deploy runs the full SvelteKit build AND creates a CloudFront
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

// Read the server-rendered visits count out of the home page HTML. Svelte 5
// SSR may emit hydration comment anchors around the text, so match the first
// digits after the element opening tag.
const readCount = (url: string) =>
  Effect.gen(function* () {
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    const count = html.match(/data-testid="count"[^>]*>(?:<!---->)?\s*(\d+)/);
    expect(count).not.toBeNull();
    return Number(count![1]);
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
  "serves the server-rendered home page",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    expect(html).toContain("SvelteKit on AWS");
    // The SSR seam (+page.server.ts, the value form) rendered the counter.
    expect(html).toContain("Server-rendered visits:");
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
  "compiles tailwind from vite.config.ts",
  Effect.gen(function* () {
    const url = yield* base;
    const res = yield* getWhenReady(url);
    expect(res.status).toBe(200);
    const html = yield* res.text;
    // The page markup uses Tailwind utilities...
    expect(html).toContain("text-3xl");
    // ...and links the stylesheet Vite emitted via the project-owned
    // vite.config.ts (the @tailwindcss/vite plugin), proving Alchemy loaded
    // the config file natively instead of the programmatic fallback.
    const match = html.match(/\/_app\/immutable\/assets\/[^"']+\.css/);
    expect(match).not.toBeNull();
    const css = yield* getBodyWhenReady(`${url}${match![0]}`, ".text-3xl");
    expect(css).toContain(".text-3xl");
    expect(css).toContain(".font-bold");
  }),
  { timeout: 180_000 },
);

test(
  "the bump form action is the public write surface",
  Effect.gen(function* () {
    const url = yield* base;
    const before = yield* readCount(url);
    // POST `/?/bump` is the exact request `use:enhance` sends. CloudFront
    // forwards it to the server Lambda, where the action calls
    // `backend.bump()` in-process (value form) against the DynamoDB
    // capability bindings (env + IAM) collected at plan time.
    const res = yield* actionWhenReady(url, "bump");
    expect(res.status).toBe(200);
    const result = (yield* res.json) as { type: string };
    expect(result.type).toBe("success");
    // A second bump observes the first write — the action really runs per
    // request against the persisted counter.
    const again = yield* actionWhenReady(url, "bump");
    expect(again.status).toBe(200);
    // The writes landed in DynamoDB: the server-rendered count reflects
    // them (poll through any stale edge cache).
    const after = yield* readCount(url).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (count) => count >= before + 2,
        times: 15,
      }),
    );
    expect(after).toBeGreaterThanOrEqual(before + 2);
  }),
  { timeout: 180_000 },
);

test(
  "queue round-trip: enqueue action, the sibling consumer catches up",
  Effect.gen(function* () {
    const url = yield* base;
    // Each run sends a unique marker so the assertion can't match a
    // message from an earlier run.
    const marker = `queue-marker-${crypto.randomUUID()}`;

    // The JSON route the page polls — a plain framework API route backed
    // by the value-form client.
    const readProcessed = Effect.gen(function* () {
      const res = yield* getWhenReady(`${url}/api/processed`);
      expect(res.status).toBe(200);
      return (yield* res.json) as { count: number; last: string | null };
    });
    const before = yield* readProcessed;

    // The enqueue form action sends to SQS and returns immediately; the
    // CONSUMER runs out of band on the sibling effect Lambda
    // (`<site>-Handlers`), whose event-source mapping was registered by
    // the same backend module.
    const res = yield* actionWhenReady(
      url,
      "enqueue",
      `message=${encodeURIComponent(marker)}`,
    );
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
  "serves a static asset from static/",
  Effect.gen(function* () {
    const url = yield* base;
    const body = yield* getBodyWhenReady(`${url}/robots.txt`, "User-agent: *");
    expect(body).toContain("User-agent: *");
  }),
  { timeout: 180_000 },
);
