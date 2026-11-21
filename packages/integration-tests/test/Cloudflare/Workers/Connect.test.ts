import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import TcpClientWorker from "./fixtures/tcp/client.ts";
import TcpEchoWorker from "./fixtures/tcp/echo.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const Stack = Alchemy.Stack(
  "WorkerConnectStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const effectEcho = yield* TcpEchoWorker;
    const asyncEcho = yield* Cloudflare.Worker("TcpAsyncEchoWorker", {
      main: pathe.resolve(import.meta.dirname, "fixtures/tcp/echo-async.ts"),
    });
    const client = yield* TcpClientWorker;
    const asyncClient = yield* Cloudflare.Worker("TcpAsyncClientWorker", {
      main: pathe.resolve(import.meta.dirname, "fixtures/tcp/client-async.ts"),
      env: {
        EFFECT_ECHO: Cloudflare.WorkerEntrypoint(effectEcho),
        ASYNC_ECHO: Cloudflare.WorkerEntrypoint(asyncEcho),
      },
    });
    return {
      clientUrl: client.url.as<string>(),
      asyncClientUrl: asyncClient.url.as<string>(),
    };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

class NotReady extends Data.TaggedError("NotReady")<{ status: number; body: string }> {}

/**
 * GET a route and return its body, retrying while a fresh workers.dev URL
 * or a just-deployed binding target is still propagating.
 */
const getText = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url);
    const body = yield* res.text;
    if (res.status !== 200) return yield* Effect.fail(new NotReady({ status: res.status, body }));
    return body;
  }).pipe(
    Effect.retry({
      schedule: Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("3 seconds")]),
      times: 15,
    }),
  );

const tags = ["provider:cloudflare", "provider:cloudflare:worker", "live"];

test(
  "Effect connect handler serves a Connect binding",
  Effect.gen(function* () {
    const { clientUrl } = yield* stack;
    const body = yield* getText(`${clientUrl}/?message=ping`);
    // The greeting proves the socket reached the handler with the address
    // the caller connected to; the echo proves both directions stream.
    expect(body).toBe("hello echo.internal:7\nPING\n");
  }),
  { timeout: 120_000, tags },
);

test(
  "Effect connect handler serves a native service-binding connect()",
  Effect.gen(function* () {
    const { asyncClientUrl } = yield* stack;
    const body = yield* getText(`${asyncClientUrl}/effect?message=effect`);
    expect(body).toBe("hello echo.internal:7\nEFFECT\n");
  }),
  { timeout: 120_000, tags },
);

test(
  "async connect handler serves a native service-binding connect()",
  Effect.gen(function* () {
    const { asyncClientUrl } = yield* stack;
    const body = yield* getText(`${asyncClientUrl}/async?message=async`);
    expect(body).toBe("hello echo.internal:7\nASYNC\n");
  }),
  { timeout: 120_000, tags },
);
