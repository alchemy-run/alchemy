import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import BindingEffectCaller from "./fixtures/binding-effect-caller.ts";
import BindingTargetWorker from "./fixtures/binding-target-worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const asyncCallerMain = pathe.resolve(
  import.meta.dirname,
  "fixtures/binding-async-caller.ts",
);

/**
 * Stack with three workers:
 *
 * - `BindingTargetWorker` — Effect-native target exposing `greet` (RPC) +
 *   `fetch`.
 * - `BindingAsyncCaller` — plain `{ fetch }` Cloudflare worker that calls
 *   `env.TARGET.greet(name)` over a service binding.
 * - `BindingEffectCaller` — Effect-native worker that uses
 *   `Cloudflare.bindWorker(BindingTargetWorker)` to call `greet` from
 *   inside an Effect.
 */
const Stack = Alchemy.Stack(
  "WorkerBindingStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const target = yield* BindingTargetWorker;

    const asyncCaller = yield* Cloudflare.Worker("BindingAsyncCaller", {
      main: asyncCallerMain,
      bindings: {
        TARGET: target,
      },
    });

    const effectCaller = yield* BindingEffectCaller;

    return {
      targetUrl: target.url.as<string>(),
      asyncCallerUrl: asyncCaller.url.as<string>(),
      effectCallerUrl: effectCaller.url.as<string>(),
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Cold-start retry — fresh `workers.dev` URLs take a few seconds to start
// answering 200, so the very first request rides this schedule.
const coldStartRetry = Effect.retry({
  schedule: Schedule.exponential("500 millis").pipe(
    Schedule.both(Schedule.recurs(20)),
  ),
});

test(
  "target worker's own fetch handler responds",
  Effect.gen(function* () {
    const { targetUrl } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* client.get(targetUrl).pipe(coldStartRetry);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("hello from BindingTargetWorker");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "async caller can call target's RPC method via service binding",
  Effect.gen(function* () {
    const { asyncCallerUrl } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* client
      .get(`${asyncCallerUrl}/?name=alice`)
      .pipe(coldStartRetry);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("hello alice");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

test(
  "effect caller can call target's RPC method via bindWorker",
  Effect.gen(function* () {
    const { effectCallerUrl } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* client
      .get(`${effectCallerUrl}/?name=bob`)
      .pipe(coldStartRetry);
    expect(res.status).toBe(200);
    expect(yield* res.text).toBe("hello bob");
  }).pipe(logLevel),
  { timeout: 180_000 },
);
