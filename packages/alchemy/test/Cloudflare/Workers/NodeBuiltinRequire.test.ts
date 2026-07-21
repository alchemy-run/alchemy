import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import RequireNodeBuiltinsWorker from "./fixtures/require-node-builtins/worker.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const Stack = Alchemy.Stack(
  "NodeBuiltinRequireTestStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* RequireNodeBuiltinsWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Regression test for #880: the deploy itself is the primary assertion —
// a bundle that keeps rolldown's throwing `require` fallback for
// `require("events")` fails Cloudflare startup validation at upload time
// and `beforeAll(deploy(Stack))` fails the suite.
test(
  "worker with a CJS dep requiring node builtins deploys and serves",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const get = client.get(`${url}/?value=pong`).pipe(
      Effect.flatMap((res) => res.text),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 5,
      }),
      Effect.orDie,
    );

    // Fresh workers.dev URLs can serve placeholder 200s while propagating,
    // so anchor the readiness poll on the fixture's marker, not the status.
    const body = yield* get.pipe(
      Effect.repeat({
        schedule: Schedule.exponential("500 millis"),
        until: (b) => b.includes("require-node-builtins:"),
        times: 10,
      }),
    );

    // The converted builtins really work at runtime: the EventEmitter
    // round-tripped the request's value and util.format made the marker.
    expect(body).toBe("require-node-builtins:pong");
  }),
  { timeout: 180_000 },
);
