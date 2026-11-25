import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { testName } from "../../names.ts";
import WfpPlatformWorker from "./fixtures/platform-worker.ts";
import {
  AsyncPlatformWorker,
  DispatchNs,
  OUTBOUND_REF_STACK,
  type OutboundParams,
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

/**
 * The stack that deploys the outbound Worker the platform Worker reaches with
 * `Cloudflare.Worker.ref`. It deploys first and is destroyed last.
 */
const OutboundRefStack = Alchemy.Stack(
  OUTBOUND_REF_STACK,
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* RefOutboundWorker;
    return { workerName: worker.workerName.as<string>() };
  }),
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

const TAGS = [
  "provider:cloudflare",
  "provider:cloudflare:worker",
  "provider:cloudflare:workersforplatforms",
  "live",
];

// Dispatch through the outbound binding and ask the user Worker to fetch
// `https://example.com/probe`. The outbound Worker answers with JSON; the
// origin itself would answer with HTML.
const egress = (
  base: string,
  scriptName: string,
  tenant?: string,
  route: "outbound" | "outbound-ref" = "outbound",
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const query = tenant === undefined ? "" : `?tenant=${tenant}`;
    const res = yield* untilOk(client.get(`${base}/${route}/${scriptName}${query}`));
    return (yield* res.json) as {
      seen?: string;
      tenant?: string | null;
      via?: string;
    };
  });

test.skipIf(!WFP_ENABLED)(
  "outbound worker intercepts user worker fetch with params (env form)",
  Effect.gen(function* () {
    const { asyncPlatformUrl, userWorkerName } = yield* stack;
    const json = yield* egress(asyncPlatformUrl, userWorkerName, "acme");
    expect(json).toEqual({ seen: "https://example.com/probe", tenant: "acme" });
  }).pipe(logLevel),
  { tags: TAGS, timeout: TEST_TIMEOUT },
);

test.skipIf(!WFP_ENABLED)(
  "outbound worker intercepts user worker fetch with params (Effect form)",
  Effect.gen(function* () {
    const { platformUrl, userWorkerName } = yield* stack;
    const json = yield* egress(platformUrl, userWorkerName, "acme");
    expect(json).toEqual({ seen: "https://example.com/probe", tenant: "acme" });
  }).pipe(logLevel),
  { tags: TAGS, timeout: TEST_TIMEOUT },
);

// Cloudflare accepts an entrypoint on a dispatch binding's outbound Worker but
// doesn't store it, and calls the default export, so the target is a Worker:
// an entrypoint is a type error, and refused before anything deploys when it
// gets past the type.
test.provider.skipIf(!WFP_ENABLED)(
  "a named WorkerEntrypoint as outbound target is refused",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = Effect.gen(function* () {
        const namespace = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace("WfpRefusedNs", {
          name: testName("alchemy-wfp-refused-entrypoint"),
        });
        return yield* Cloudflare.Worker("WfpRefusedPlatform", {
          script: `export default { fetch: () => new Response("ok") };`,
          env: {
            DISPATCH: Cloudflare.WorkersForPlatforms.Get<OutboundParams>(namespace, {
              outbound: Cloudflare.WorkerEntrypoint(
                Cloudflare.Worker.ref("WfpOutboundWorker") as unknown as Cloudflare.Worker,
                "Egress",
              ) as unknown as Cloudflare.Worker,
              parameters: ["tenant"],
            }),
          },
        });
      });
      const exit = yield* stack.deploy(program).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("calls its default export");
      }
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: TAGS, timeout: TEST_TIMEOUT },
);

test.skipIf(!WFP_ENABLED)(
  "outbound to a Worker.ref target",
  Effect.gen(function* () {
    const { platformUrl, userWorkerName } = yield* stack;
    const json = yield* egress(platformUrl, userWorkerName, "acme", "outbound-ref");
    expect(json).toEqual({ seen: "https://example.com/probe", tenant: "acme", via: "ref" });
  }).pipe(logLevel),
  { tags: TAGS, timeout: TEST_TIMEOUT },
);

// Cloudflare requires every declared outbound value on each dispatch, which
// is why the types require them. The fixtures bypass the type with
// `?probe=omit|undefined` to pin what the platform does.
test.skipIf(!WFP_ENABLED)(
  "every declared outbound value is required; null passes as null",
  Effect.gen(function* () {
    const { asyncPlatformUrl, platformUrl, userWorkerName } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    for (const base of [asyncPlatformUrl, platformUrl]) {
      const json = yield* egress(base, userWorkerName);
      expect(json).toEqual({ seen: "https://example.com/probe", tenant: null });

      const omitted = yield* client.get(`${base}/outbound/${userWorkerName}?probe=omit`);
      expect(omitted.status).toBe(500);
      const { error } = (yield* omitted.json) as { error: string };
      expect(error).toContain("Missing one or more required arguments to worker");

      const undef = yield* client.get(`${base}/outbound/${userWorkerName}?probe=undefined`);
      expect(undef.status).toBe(500);
    }
  }).pipe(logLevel),
  { tags: TAGS, timeout: TEST_TIMEOUT },
);
