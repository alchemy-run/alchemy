import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const targetScript = `export default {
  async fetch() {
    return new Response("hello from target");
  },
};
`;

// Forwards to the managed binding or the lookup binding, per path.
const consumerScript = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/managed")) {
      return env.TARGET_MANAGED.fetch(new Request("https://target/"));
    }
    if (url.pathname.startsWith("/lookup")) {
      return env.TARGET_LOOKUP.fetch(new Request("https://target/"));
    }
    return new Response("ok");
  },
};
`;

// Yielded in both deploys (same logical id), so the first deploy creates it and
// the second is a no-op reconcile that keeps it alive while the consumer binds.
const targetWorker = Cloudflare.Worker("lookup-target-worker", {
  script: targetScript,
});

// Read the worker's live `service` bindings out-of-band from the script
// settings API.
const readServiceBindings = (scriptName: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const settings = yield* workers.getScriptScriptAndVersionSetting({
      accountId,
      scriptName,
    });
    return (settings.bindings ?? []).filter(
      (b): b is Extract<typeof b, { type: "service" }> => b.type === "service",
    );
  });

// A freshly-deployed workers.dev URL 404s for a few seconds before it starts
// serving.
const getText = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new Error(`worker not ready: ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("3 seconds"),
        ]),
        times: 15,
      }),
    );
    return yield* res.text;
  });

test.provider(
  "looks up a worker by name and binds it to a worker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const target = yield* stack.deploy(targetWorker);

      // Bind it two ways — the managed resource directly, and a `lookup` data
      // source by deployed name. Both emit a `service` binding. The lookup is
      // also returned as a stack output, pinning plan-time Output resolution.
      const { looked, consumer } = yield* stack.deploy(
        Effect.gen(function* () {
          const managed = yield* targetWorker;
          const consumer = yield* Cloudflare.Worker("lookup-consumer-worker", {
            script: consumerScript,
            env: {
              TARGET_MANAGED: managed,
              TARGET_LOOKUP: Cloudflare.Worker.lookup({
                name: target.workerName,
              }),
            },
          });
          return {
            looked: Cloudflare.Worker.lookup({ name: target.workerName }),
            consumer,
          };
        }),
      );

      expect(looked.workerName).toEqual(target.workerName);
      expect(looked.workerId).toEqual(target.workerName);

      const services = yield* readServiceBindings(consumer.workerName);
      expect(
        services.find((b) => b.name === "TARGET_MANAGED")?.service,
      ).toEqual(target.workerName);
      expect(services.find((b) => b.name === "TARGET_LOOKUP")?.service).toEqual(
        target.workerName,
      );

      expect(yield* getText(`${consumer.url!}/managed`)).toBe(
        "hello from target",
      );
      expect(yield* getText(`${consumer.url!}/lookup`)).toBe(
        "hello from target",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider(
  "fails the deploy when the looked-up worker does not exist",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const exit = yield* Effect.exit(
        stack.deploy(
          Effect.gen(function* () {
            return {
              missing: Cloudflare.Worker.lookup({
                name: "alchemy-worker-lookup-does-not-exist",
              }),
            };
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
