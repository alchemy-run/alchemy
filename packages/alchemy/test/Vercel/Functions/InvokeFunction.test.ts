/**
 * Vercel InvokeFunction capability tests — live against the standing
 * Vercel test team (run with the doppler alchemy-v2/dev env).
 *
 * Covers THE circular pre-create story: two Effect-mode Functions A↔B each
 * binding `invoke(other)` — A by importing B's class, B by the
 * `{ LogicalId }` forward reference that keeps the module/type graph
 * acyclic — so each side's URL and protection-bypass secret must be read
 * back off the pre-created stub before either deploys. Also a simple
 * one-way async-mode test driving the same attributes through the plain
 * `env:` channel.
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as projects from "@distilled.cloud/vercel/projects";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import InvokeEchoA from "./fixtures/invoke-a.ts";
import InvokeEchoB from "./fixtures/invoke-b.ts";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const asyncTargetMain = new URL("./fixtures/handler.ts", import.meta.url)
  .pathname;
const asyncCallerMain = new URL(
  "./fixtures/invoke-async-caller.ts",
  import.meta.url,
).pathname;

// Fresh .vercel.app URLs take a few seconds to start serving 200s — always
// retry the first request (bounded: `times` on the retry is the hard cap).
const readiness = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("2 seconds"),
]);

const getJson = (url: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(url);
    const body = yield* response.text;
    if (response.status !== 200) {
      return yield* Effect.fail(
        new Error(`status ${response.status}: ${body.slice(0, 300)}`),
      );
    }
    // Fresh production aliases can transiently serve a 200 HTML edge
    // placeholder before the deployment is routed — treat an unparseable
    // body as retryable, not a crash.
    return yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: () =>
        new Error(`status 200 but non-JSON body: ${body.slice(0, 300)}`),
    });
  }).pipe(
    // Bounded: the schedule alone is NOT a bound (Schedule.max keeps
    // recurring while either input does) — `times` is the hard cap.
    Effect.retry({ schedule: readiness, times: 40 }),
  );

/** Poll (bounded) until the function's project is gone. */
const expectProjectGone = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const gone = yield* projects
      .getProject({ idOrName: projectId, teamId })
      .pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (g) => g,
          times: 10,
        }),
      );
    expect(gone).toBe(true);
  });

interface CallResponse {
  fn: string;
  targetUrl: string;
  target: { fn: string; echo: string };
}

test.provider(
  "circular invoke: A and B each binding invoke(other) round-trips both ways",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { a, b } = yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* InvokeEchoA;
          const b = yield* InvokeEchoB;
          return { a, b };
        }),
      );

      // Both URLs are real read-back values (assigned production domains),
      // not computed placeholders — and they are distinct projects.
      expect(a.url).toMatch(/^https:\/\/.+\.vercel\.app$/);
      expect(b.url).toMatch(/^https:\/\/.+\.vercel\.app$/);
      expect(a.url).not.toEqual(b.url);
      expect(a.projectId).not.toEqual(b.projectId);
      // The bypass secrets the runtime clients send were minted pre-deploy.
      expect(a.protectionBypass).toBeDefined();
      expect(b.protectionBypass).toBeDefined();

      // A → B: A's handler invokes B's /echo through the capability client
      // (bypass header + env-bound URL) and reports the runtime-bound URL.
      const viaA = (yield* getJson(`${a.url}/call-b`)) as CallResponse;
      expect(viaA.fn).toEqual("a");
      expect(viaA.targetUrl).toEqual(b.url);
      expect(viaA.target.fn).toEqual("b");
      expect(viaA.target.echo).toContain("from=a");

      // B → A: the other direction of the cycle.
      const viaB = (yield* getJson(`${b.url}/call-a`)) as CallResponse;
      expect(viaB.fn).toEqual("b");
      expect(viaB.targetUrl).toEqual(a.url);
      expect(viaB.target.fn).toEqual("a");
      expect(viaB.target.echo).toContain("from=b");

      yield* stack.destroy();
      yield* expectProjectGone(a.projectId);
      yield* expectProjectGone(b.projectId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "async env: one-way TARGET_URL/TARGET_BYPASS attribute binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { caller, target } = yield* stack.deploy(
        Effect.gen(function* () {
          const target = yield* Vercel.Function("InvokeAsyncTarget", {
            main: asyncTargetMain,
          });
          const caller = yield* Vercel.Function("InvokeAsyncCaller", {
            main: asyncCallerMain,
            env: {
              TARGET_URL: target.url,
              TARGET_BYPASS: target.protectionBypass,
            },
          });
          return { caller, target };
        }),
      );
      expect(target.url).toMatch(/^https:\/\/.+\.vercel\.app$/);
      expect(caller.url).toBeDefined();

      // The caller replies 200 immediately with the INNER target-fetch
      // status embedded — poll (bounded) until the target URL serves 200s
      // through the caller, so fresh-URL propagation can't flake the test.
      const result = yield* getJson(`${caller.url}/call`).pipe(
        Effect.map((r) => r as { status: number; body: { echo: string } }),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (r) => r.status === 200,
          times: 20,
        }),
      );
      expect(result.status).toBe(200);
      expect(result.body.echo).toEqual("hi from caller");

      yield* stack.destroy();
      yield* expectProjectGone(caller.projectId);
      yield* expectProjectGone(target.projectId);
    }).pipe(logLevel),
  { timeout: 180_000 },
);
