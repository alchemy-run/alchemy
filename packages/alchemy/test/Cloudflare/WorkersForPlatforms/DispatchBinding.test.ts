import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import WfpPlatformWorker from "./fixtures/platform-worker.ts";
import { DispatchNs, userWorkerScript } from "./fixtures/shared.ts";

/**
 * End-to-end test for the Workers for Platforms dynamic-dispatch binding
 * (`Cloudflare.WorkersForPlatforms.Get`). Deploys a dispatch namespace, a user
 * Worker uploaded *into* it (via the Worker `namespace` prop), and a platform
 * Worker that binds the namespace and forwards requests to the user Worker by
 * script name. The platform Worker is then driven over HTTP.
 *
 * Workers for Platforms is a paid add-on. The standing test account is
 * entitled, so this runs live by default; set `CLOUDFLARE_TEST_WFP=0` to skip
 * the suite skip-clean on a non-entitled account.
 */
const WFP_ENABLED = process.env.CLOUDFLARE_TEST_WFP !== "0";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 180_000;

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const Stack = Alchemy.Stack(
  "WfpDispatchBindingStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    // Reference the namespace by its `name` output: resolves to the namespace
    // name string and establishes the dependency edge so the namespace is
    // created before the user Worker is uploaded into it.
    const ns = yield* DispatchNs;
    const userWorker = yield* Cloudflare.Worker("WfpBindingUserWorker", {
      namespace: ns.name,
      script: userWorkerScript,
    });
    const platformWorker = yield* WfpPlatformWorker;
    return {
      platformUrl: platformWorker.url.as<string>(),
      userWorkerName: userWorker.workerName.as<string>(),
    };
  }),
);

class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  body: string;
}> {}

// Fresh workers.dev URLs take a few seconds to start serving 200s; ride out
// cold-start non-200s with a bounded spaced schedule so a real failure
// surfaces fast instead of running to the vitest timeout.
const untilOk = <E, R>(
  eff: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>,
) =>
  eff.pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(new NotReady({ status: res.status, body })),
            ),
          ),
    ),
    Effect.retry({
      while: (e): e is NotReady => e instanceof NotReady,
      schedule: Schedule.spaced("2 seconds").pipe(
        Schedule.both(Schedule.recurs(30)),
      ),
    }),
  );

const stack = beforeAll(
  WFP_ENABLED
    ? deploy(Stack)
    : Effect.succeed({ platformUrl: "", userWorkerName: "" }),
  { timeout: HOOK_TIMEOUT },
);
afterAll.skipIf(!WFP_ENABLED || !!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: HOOK_TIMEOUT,
});

test.skipIf(!WFP_ENABLED)(
  "platform worker dispatches to a user worker in the namespace",
  Effect.gen(function* () {
    const { platformUrl, userWorkerName } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const res = yield* untilOk(
      client.get(`${platformUrl}/dispatch/${userWorkerName}/hello`, {
        headers: { "x-custom": "ping" },
      }),
    );
    expect(res.status).toBe(200);

    const body = (yield* res.json) as {
      handledBy: string;
      path: string;
      customHeader: string;
    };
    // Proves the request reached the dispatched user worker — not the platform
    // worker's own fallback route.
    expect(body.handledBy).toBe("user-worker");
    expect(body.path).toBe("/hello");
    expect(body.customHeader).toBe("ping");
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);

test.skipIf(!WFP_ENABLED)(
  "dispatching an unknown script does not reach a user worker",
  Effect.gen(function* () {
    const { platformUrl } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    // A script that doesn't exist in the namespace can't be dispatched to:
    // the forwarded fetch surfaces as a 404 from the edge rather than a
    // dispatched 200. Either way it must be an error status, never a real
    // user-worker response.
    const res = yield* client
      .get(`${platformUrl}/dispatch/this-script-does-not-exist/x`)
      .pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );
    expect(res.status).toBeGreaterThanOrEqual(400);
  }).pipe(logLevel),
  { timeout: TEST_TIMEOUT },
);
