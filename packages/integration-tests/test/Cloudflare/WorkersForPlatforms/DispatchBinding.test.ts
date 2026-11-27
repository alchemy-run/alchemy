import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import WfpPlatformWorker from "./fixtures/platform-worker.ts";
import {
  AsyncPlatformWorker,
  DispatchNs,
  OUTBOUND_REF_STACK,
  OutboundWorker,
  RefOutboundWorker,
  userWorkerScript,
} from "./fixtures/shared.ts";

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

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

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
    yield* OutboundWorker;
    const platformWorker = yield* WfpPlatformWorker;
    const asyncPlatformWorker = yield* AsyncPlatformWorker;
    return {
      platformUrl: platformWorker.url.as<string>(),
      asyncPlatformUrl: asyncPlatformWorker.url.as<string>(),
      userWorkerName: userWorker.workerName.as<string>(),
    };
  }),
);

// Deploys the outbound Worker the platform Worker reaches with
// `Cloudflare.Worker.ref`. It deploys first and is destroyed last.
const OutboundRefStack = Alchemy.Stack(
  OUTBOUND_REF_STACK,
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  RefOutboundWorker.pipe(Effect.asVoid),
);

class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  body: string;
}> {}

// Fresh workers.dev URLs take a few seconds to start serving 200s; ride out
// cold-start non-200s with a bounded spaced schedule so a real failure
// surfaces fast instead of running to the vitest timeout.
const untilOk = <E, R>(eff: Effect.Effect<HttpClientResponse.HttpClientResponse, E, R>) =>
  eff.pipe(
    Effect.flatMap((res) =>
      res.status === 200
        ? Effect.succeed(res)
        : res.text.pipe(
            Effect.flatMap((body) => Effect.fail(new NotReady({ status: res.status, body }))),
          ),
    ),
    Effect.retry({
      while: (e): e is NotReady => e instanceof NotReady,
      schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(30)]),
    }),
  );

const stack = beforeAll(
  WFP_ENABLED
    ? deploy(OutboundRefStack).pipe(Effect.andThen(deploy(Stack)))
    : Effect.succeed({
        platformUrl: "",
        asyncPlatformUrl: "",
        userWorkerName: "",
      }),
  { timeout: HOOK_TIMEOUT },
);
afterAll.skipIf(!WFP_ENABLED || !!process.env.NO_DESTROY)(
  destroy(Stack).pipe(Effect.andThen(destroy(OutboundRefStack))),
  { timeout: HOOK_TIMEOUT },
);

// Drive one platform worker base URL: dispatch to `scriptName`, assert the
// request reached the dispatched user worker (not the platform worker's own
// fallback) and that the path + header were forwarded.
const assertDispatch = (base: string, scriptName: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* untilOk(
      client.get(`${base}/dispatch/${scriptName}/hello`, {
        headers: { "x-custom": "ping" },
      }),
    );
    expect(res.status).toBe(200);

    const body = (yield* res.json) as {
      handledBy: string;
      path: string;
      customHeader: string;
    };
    expect(body.handledBy).toBe("user-worker");
    expect(body.path).toBe("/hello");
    expect(body.customHeader).toBe("ping");
  });

// Effect-native platform worker: binds the namespace via `Get`.
test.skipIf(!WFP_ENABLED)(
  "Get binding dispatches to a user worker in the namespace",
  Effect.gen(function* () {
    const { platformUrl, userWorkerName } = yield* stack;
    yield* assertDispatch(platformUrl, userWorkerName);
  }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:cloudflare:workersforplatforms",
      "live",
    ],
    timeout: TEST_TIMEOUT,
  },
);

// Async platform worker: binds the namespace via `env: { DISPATCH }` + InferEnv.
test.skipIf(!WFP_ENABLED)(
  "env binding (InferEnv) dispatches to a user worker in the namespace",
  Effect.gen(function* () {
    const { asyncPlatformUrl, userWorkerName } = yield* stack;
    yield* assertDispatch(asyncPlatformUrl, userWorkerName);
  }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:cloudflare:workersforplatforms",
      "live",
    ],
    timeout: TEST_TIMEOUT,
  },
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
    const res = yield* client.get(`${platformUrl}/dispatch/this-script-does-not-exist/x`).pipe(
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 8,
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:cloudflare:workersforplatforms",
      "live",
    ],
    timeout: TEST_TIMEOUT,
  },
);

// The user Worker fetches `https://example.com/probe`: the outbound Worker
// answers it with JSON, where the origin would answer with HTML.
const assertEgress = (base: string, route: string, via: string) =>
  Effect.gen(function* () {
    const { userWorkerName } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const res = yield* untilOk(client.get(`${base}/${route}/${userWorkerName}?tenant=acme`));
    expect(yield* res.json).toEqual({ seen: "https://example.com/probe", tenant: "acme", via });
  }).pipe(logLevel);

const OUTBOUND_OPTIONS = {
  tags: [
    "provider:cloudflare",
    "provider:cloudflare:worker",
    "provider:cloudflare:workersforplatforms",
    "live",
  ],
  timeout: TEST_TIMEOUT,
};

test.skipIf(!WFP_ENABLED)(
  "an outbound Worker receives a user Worker's fetch and the dispatch's values (env binding)",
  Effect.gen(function* () {
    yield* assertEgress((yield* stack).asyncPlatformUrl, "outbound", "stack");
  }),
  OUTBOUND_OPTIONS,
);

test.skipIf(!WFP_ENABLED)(
  "an outbound Worker receives a user Worker's fetch and the dispatch's values (Effect binding)",
  Effect.gen(function* () {
    yield* assertEgress((yield* stack).platformUrl, "outbound", "stack");
  }),
  OUTBOUND_OPTIONS,
);

test.skipIf(!WFP_ENABLED)(
  "an outbound Worker another stack deploys, by Worker.ref",
  Effect.gen(function* () {
    yield* assertEgress((yield* stack).platformUrl, "outbound-ref", "ref");
  }),
  OUTBOUND_OPTIONS,
);

// Cloudflare requires every declared outbound value on each dispatch, which
// is why the types require them. `?probe=omit` bypasses the type.
test.skipIf(!WFP_ENABLED)(
  "a dispatch that leaves a declared outbound value out is refused; null passes",
  Effect.gen(function* () {
    const { asyncPlatformUrl, platformUrl, userWorkerName } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    for (const base of [asyncPlatformUrl, platformUrl]) {
      const none = yield* untilOk(client.get(`${base}/outbound/${userWorkerName}`));
      expect(yield* none.json).toMatchObject({ tenant: null });

      const omitted = yield* client.get(`${base}/outbound/${userWorkerName}?probe=omit`);
      expect(omitted.status).toBe(500);
      expect(((yield* omitted.json) as { error: string }).error).toContain(
        "Missing one or more required arguments to worker",
      );
    }
  }).pipe(logLevel),
  OUTBOUND_OPTIONS,
);

test.skipIf(!WFP_ENABLED)(
  "an Effect HttpClient calls a dispatched user Worker through its Fetcher",
  Effect.gen(function* () {
    const { platformUrl, userWorkerName } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    const res = yield* untilOk(client.get(`${platformUrl}/client/${userWorkerName}`));
    expect(yield* res.json).toMatchObject({ handledBy: "user-worker", path: "/via-client" });
  }).pipe(logLevel),
  OUTBOUND_OPTIONS,
);
