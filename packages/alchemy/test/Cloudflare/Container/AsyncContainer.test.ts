import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import AsyncContainerStack from "./fixtures/async/stack.ts";

/**
 * Container-backed Durable Object on a plain async Worker (issue #953): the
 * DO class ships in the worker script (from `@cloudflare/containers`), and the
 * stack attaches the container via
 * `Cloudflare.DurableObject("AsyncEchoObject", { container })`. The deploy
 * must upload `containers: [{ className }]` script metadata — without it,
 * Cloudflare never treats the class as container-backed, `ctx.container` is
 * undefined, and every request through the class fails.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Container image pull + push + worker/DO deploy comfortably exceeds the
// default 120s hook budget (mirrors Container.test.ts).
const HOOK_TIMEOUT = 600_000;

const stack = beforeAll(deploy(AsyncContainerStack), {
  timeout: HOOK_TIMEOUT,
});
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(AsyncContainerStack), {
  timeout: HOOK_TIMEOUT,
});

// Cap exponential backoff at 3s — keeps the fast path snappy but stops the
// geometric blow-up from dominating wall time when CF edge is slow.
const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);
const readinessRetries = 60;

// While a freshly pre-created worker propagates, Cloudflare's edge serves
// Alchemy's pre-create stub (200 with this body); any poll that sees it retries.
const DEPLOY_PLACEHOLDER = "Alchemy worker is being deployed...";

// Force `Connection: close` so each readiness attempt opens a fresh connection
// and can land on an edge that already has the new deploy (a pooled keep-alive
// socket stays pinned to one edge metal and can keep reading the stale body).
const freshConn = HttpClient.HttpClient.pipe(
  Effect.map(
    HttpClient.mapRequest(HttpClientRequest.setHeader("connection", "close")),
  ),
);

// Retry a freshly-deployed worker route until it answers 200 with a body that
// contains `expected` — rejecting both transient non-200s and the deploy stub.
const fetchReady = (url: URL, expected: string) =>
  Effect.gen(function* () {
    const client = yield* freshConn;
    return yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        r.text.pipe(
          Effect.flatMap((body) =>
            r.status !== 200
              ? Effect.fail(new Error(`Worker not ready: ${r.status} ${body}`))
              : body.includes(DEPLOY_PLACEHOLDER) || !body.includes(expected)
                ? Effect.fail(new Error(`not ready: got ${body}`))
                : Effect.succeed(body),
          ),
        ),
      ),
      Effect.timeout("10 seconds"),
      Effect.retry({ schedule: readinessSchedule, times: readinessRetries }),
    );
  });

test(
  "async worker serves through its container-backed DO class",
  Effect.gen(function* () {
    const { url } = yield* stack;

    // The echo image reflects the request as JSON ("method" only appears in
    // a real echo response, never in an error page) — proof the request went
    // Worker → DO class → container port 8080 and back.
    const hello = yield* fetchReady(new URL("/hello", url), "method");
    expect(hello).toContain("method");
  }).pipe(logLevel),
  { timeout: 300_000 },
);
