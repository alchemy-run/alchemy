/**
 * Pins the documented bridge contract (AGENTS.md + Worker JSDoc):
 * "`Effect.addFinalizer` in a handler runs post-response via `ctx.waitUntil`"
 * — including the LATENCY half of that promise.
 *
 * `EffectHttp.toHandled` runs the handler under its OWN internal per-request
 * scope and closes it INLINE right after the response callback, so without
 * scope ejection (see `toHandledWebResponse` in
 * `src/Cloudflare/Workers/HttpServer.ts`) a handler's `Effect.addFinalizer`
 * delays the HTTP response by the finalizer's full duration. The fixture's
 * `/finalize` route registers a 3s finalizer; the timed request must come
 * back well under that, and the finalizer must still run afterwards
 * (durable-object journal readback, isolate-independent).
 */
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { expectUrlContains } from "../Utils/Http.ts";
import Stack from "./fixtures/finalizer-latency/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Cache-busting query param on every request: after destroy+recreate of the
// same workers.dev subdomain the edge can serve a cached placeholder for the
// bare URL. Route matching uses `url.pathname`, so the param is invisible to
// the fixture.
let bust = 0;
const getText = (
  client: HttpClient.HttpClient,
  url: string,
): Effect.Effect<string, unknown> =>
  client
    .get(`${url}?cb=${Date.now()}-${bust++}`)
    .pipe(Effect.flatMap((res) => res.text));

describe.skipIf(!!process.env.FAST)(
  "request finalizers never delay the response",
  () => {
    test(
      "a 3s Effect.addFinalizer does not delay the fetch response (and still runs post-response)",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const client = yield* HttpClient.HttpClient;

        // Content-based readiness through workers.dev propagation — this
        // also warms the isolate so the timed request below measures the
        // handler, not a cold start.
        yield* expectUrlContains(`${url}/ready`, "ready-ok", {
          label: "finalizer-latency worker propagation",
        });

        // The timed request: the handler registers a 3s finalizer then
        // responds. The contract is that the finalizer settles post-response
        // under ctx.waitUntil — so the round-trip must NOT include the 3s.
        // (Against the pre-fix bridge this measures ~3.0-3.5s.)
        const [elapsed, body] = yield* Effect.timed(
          getText(client, `${url}/finalize`),
        );
        expect(body).toBe("finalizer-scheduled");
        yield* Effect.log(
          `/finalize round-trip: ${Duration.toMillis(elapsed)}ms (3s finalizer)`,
        );
        expect(Duration.toMillis(elapsed)).toBeLessThan(2500);

        // ...and the finalizer DID run afterwards: it appends a journal
        // entry to the Durable Object ~3s after the response.
        const entries = yield* Effect.gen(function* () {
          const text = yield* getText(client, `${url}/entries`);
          const parsed = yield* Effect.try(
            () => JSON.parse(text) as { entries?: string[] },
          );
          return parsed.entries ?? [];
        }).pipe(
          Effect.catch(() => Effect.succeed([] as string[])),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (entries) => entries.includes("slow-finalizer-ran"),
            times: 30,
          }),
        );
        expect(entries).toContain("slow-finalizer-ran");
      }).pipe(logLevel),
      { timeout: 180_000 },
    );
  },
);
