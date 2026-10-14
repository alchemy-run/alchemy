import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import EntrypointPropsWorker from "./fixtures/entrypoint-props/worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

/** GET a route, retrying until the freshly started workerd serves a 200. */
const getTextReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : res.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(new WorkerNotReady({ status: res.status, body })),
              ),
            ),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("2 seconds")]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.text;
  }).pipe(Effect.orDie);

/**
 * Under `alchemy dev`, local workerd serves `ctx.props` and the
 * `ctx.exports` loopback the same way the deployed Worker does.
 */
test.provider(
  "local worker reads ctx.props and mints self entrypoint stubs with props",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(EntrypointPropsWorker);

      // Dev marker: served from the local dev proxy, no cloud deploy ran.
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      const tenant = `props=${JSON.stringify({ tenant: "acme" })}`;
      expect(yield* getTextReady(`${deployed.url}/props`)).toBe("props={}");
      expect(yield* getTextReady(`${deployed.url}/mint`)).toBe(`via-worker:${tenant}`);
      expect(yield* getTextReady(`${deployed.url}/mint-do`)).toBe(`via-do:${tenant}`);
      expect(yield* getTextReady(`${deployed.url}/missing`)).toBe(
        "EntrypointUnavailableError:Missing",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 180_000,
  },
);
