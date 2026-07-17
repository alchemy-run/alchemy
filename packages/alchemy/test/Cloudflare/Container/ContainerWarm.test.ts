import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import WarmStack from "./fixtures/warm/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Image build + push + worker/DO deploy comfortably exceeds the default hook
// budget; the warm tests then wait out a real keep-warm cadence on top.
const HOOK_TIMEOUT = 600_000;
const TEST_TIMEOUT = 300_000;

const DEPLOY_PLACEHOLDER = "Alchemy worker is being deployed...";

// Force `Connection: close` so each attempt opens a fresh connection and can
// land on an edge that already has the new deploy / restarted container.
const freshConn = HttpClient.mapRequest(
  HttpClientRequest.setHeader("connection", "close"),
);

const readinessSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("3 seconds"),
]);

// Retry a route until it answers 200 with a body containing `expected`,
// rejecting transient non-200s and the pre-create deploy stub.
const fetchReady = (url: string, expected: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    return yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        r.status !== 200
          ? Effect.fail(new Error(`not ready: ${r.status}`))
          : Effect.flatMap(r.text, (body) =>
              body.includes(DEPLOY_PLACEHOLDER) || !body.includes(expected)
                ? Effect.fail(new Error(`not ready: got ${body}`))
                : Effect.succeed(body),
            ),
      ),
      Effect.timeout("30 seconds"),
      Effect.retry({ schedule: readinessSchedule, times: 40 }),
    );
  });

// GET a route and return its parsed JSON body, riding out a cold edge the same
// way `fetchReady` does. Without the retry, a request that lands before the
// deploy has propagated gets Cloudflare's own 404 HTML page and dies on
// `JSON Parse error: Unrecognized token '<'` — a test failure that says
// nothing about the code under test.
const json = <T>(url: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status !== 200
          ? Effect.fail(new Error(`not ready: ${res.status}`))
          : (res.json as Effect.Effect<unknown, unknown>),
      ),
      Effect.map((body) => body as T),
      Effect.timeout("30 seconds"),
      Effect.retry({ schedule: readinessSchedule, times: 40 }),
    );
  });

// Poll `/running` until the reported state matches `want`. Reading the flag
// never restarts the container, so a `false → true` transition observed here
// with no other traffic in flight is attributable to `keepWarm` alone.
const waitRunning = (baseUrl: string, name: string, want: boolean) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    return yield* client
      .get(`${baseUrl}/running?name=${encodeURIComponent(name)}`)
      .pipe(
        Effect.flatMap((r) =>
          r.status !== 200
            ? Effect.fail(new Error(`running not ready: ${r.status}`))
            : Effect.flatMap(r.json, (body) => {
                const running = (body as { running?: boolean }).running;
                return running === want
                  ? Effect.succeed(running)
                  : Effect.fail(new Error(`running=${running}, want ${want}`));
              }),
        ),
        Effect.timeout("15 seconds"),
        Effect.retry({ schedule: readinessSchedule, times: 40 }),
      );
  });

/**
 * `keepWarm` (a container kept warm for the life of its DO) and `warmPool`
 * (containers booted ahead of anyone's first request). The two are
 * complementary, and the fixture wires both onto the same DO.
 *
 * The negative control lives in `ContainerRestart.test.ts`: its container
 * carries no `keepWarm`, and its tests only ever pass once a stopped
 * container *stays* stopped until the next real request. So "the container
 * came back on its own" here is a property of `keepWarm`, not of the
 * platform.
 */
describe("container warming", () => {
  const stack = beforeAll(deploy(WarmStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(WarmStack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    "keepWarm restarts a stopped container with no requests in between",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const name = "keep-warm";

      // Start + confirm up, and take the boot id of this container process.
      expect(yield* fetchReady(`${url}/ping?name=${name}`, "pong")).toContain(
        "pong",
      );
      const before = yield* json<{ boot: string }>(`${url}/boot?name=${name}`);

      // Hard-stop it and confirm it is actually down. The keep-warm cadence is
      // long relative to this probe, so the container is observably stopped
      // before the schedule's next tick can act on it.
      yield* fetchReady(`${url}/stop?name=${name}`, "stopped");
      yield* waitRunning(url, name, false);

      // The assertion: it comes back with ZERO requests touching the
      // container. `/running` only reads a flag, so the only thing that can
      // flip it back is the keepWarm schedule.
      expect(yield* waitRunning(url, name, true)).toBe(true);

      // ...and it is a genuinely new process, so the flag flipped because the
      // container really restarted rather than never having gone down.
      const after = yield* json<{ boot: string }>(`${url}/boot?name=${name}`);
      expect(after.boot).not.toBe(before.boot);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );

  test(
    "warmPool wakes every named DO and boots its container",
    Effect.gen(function* () {
      const { url } = yield* stack;
      // Names no test has ever addressed: nothing has constructed these DOs,
      // so nothing has started their containers.
      const names = ["pool-a", "pool-b", "pool-c"];

      const result = yield* json<{ warmed: string[] }>(
        `${url}/warm?names=${names.join(",")}&concurrency=2`,
      );
      expect(result.warmed).toEqual(names);

      for (const name of names) {
        // Each DO recorded the wake itself, so the fan-out demonstrably
        // reached every name (not just the first, and not only the ones the
        // concurrency window admitted first).
        const warmed = yield* json<{ count: number }>(
          `${url}/warmed?name=${name}`,
        );
        expect(warmed.count).toBeGreaterThanOrEqual(1);

        // ...and the wake set the container booting. This is polled, not read
        // at wake time: `ensureRunning` calls `container.start()`, which asks
        // for a boot rather than waiting one out, so `running` is still false
        // while the wake handler itself is on the stack. Warming ahead of the
        // first request only promises the boot is already under way by then —
        // so that is what this asserts.
        //
        // `/running` only reads a flag; no request here ever touches the
        // container.
        expect(yield* waitRunning(url, name, true)).toBe(true);
      }
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
