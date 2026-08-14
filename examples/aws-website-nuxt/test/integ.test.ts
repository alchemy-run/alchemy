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
  providers: AWS.providers(),
  state: AWS.state(),
  stage: "test",
});

// The first deploy runs the full Nuxt build AND creates a CloudFront
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
    expect(html).toContain("Nuxt on AWS");
    // The SSR seam (useAsyncData server branch, the value form) rendered
    // the counter.
    expect(html).toContain("Server-rendered visits:");
  }),
  { timeout: 180_000 },
);

test(
  "serves the plain nitro api route",
  Effect.gen(function* () {
    // /api/hello is a plain nitro route — the alchemy middleware only
    // dispatches the rpc path and declines everything else (the backend
    // exposes no fetch), so nitro's own handler answers. This pins the
    // coexistence contract end-to-end.
    const url = yield* base;
    const body = yield* getBodyWhenReady(`${url}/api/hello`, "from nitro");
    expect(JSON.parse(body)).toEqual({ hello: "from nitro" });
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
  "serves the backend methods over the rpc wire path",
  Effect.gen(function* () {
    const url = yield* base;
    // `POST /api/__rpc/bump` is the exact wire request the browser's
    // type-only `createClient<typeof Backend>()` sends. It is dispatched
    // by the middleware mount (toEventHandler at
    // server/middleware/alchemy.ts, compiled by nitro into the same
    // server Lambda) before route matching. The DynamoDB capability
    // bindings (env + IAM) were collected at plan time.
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

test(
  "SSR renders the backend value loaded in-process by useAsyncData",
  Effect.gen(function* () {
    const url = yield* base;
    // The previous test bumped through the wire; the page's useAsyncData
    // handler reads the same DynamoDB counter with the VALUE form of
    // createClient (direct in-process dispatch) during SSR and renders
    // it into the HTML.
    const html = yield* getBodyWhenReady(url, "Server-rendered visits:");
    const visits = html.match(/Server-rendered visits:[\s\S]{0,200}?(\d+)/);
    expect(visits).not.toBeNull();
    expect(Number(visits![1])).toBeGreaterThanOrEqual(2);
  }),
  { timeout: 180_000 },
);

test(
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
