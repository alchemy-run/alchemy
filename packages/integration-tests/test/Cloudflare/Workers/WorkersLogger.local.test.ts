import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import WorkersLoggerOverrideWorker from "./fixtures/workers-logger/override-worker.ts";
import type { ConsoleCall } from "./fixtures/workers-logger/record.ts";
import WorkersLoggerWorker from "./fixtures/workers-logger/worker.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const ConsoleCalls = Schema.Array(
  Schema.Struct({ method: Schema.String, args: Schema.Array(Schema.Unknown) }),
);

/** GET a route, retrying until the freshly started workerd serves a 200. */
const getCalls = Effect.fn(function* (url: string) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : response.text.pipe(
            Effect.flatMap((body) => Effect.fail(new Error(`${url}: ${response.status}: ${body}`))),
          ),
    ),
    Effect.retry({ schedule: Schedule.spaced("1 second"), times: 15 }),
    Effect.flatMap(Schema.decodeUnknownEffect(ConsoleCalls)),
  );
});

const line = (message: string) => ({
  message,
  reason: "card_declined",
  spanName: "checkout.charge",
});

/** What `fixtures/workers-logger/record.ts`'s `logEveryLevel` writes through the default logger. */
const everyLevel: ReadonlyArray<ConsoleCall> = [
  { method: "error", args: [line("fatal")] },
  { method: "error", args: [line("error")] },
  { method: "warn", args: [line("warning")] },
  { method: "info", args: [line("info")] },
  { method: "debug", args: [line("debug")] },
  { method: "debug", args: [line("trace")] },
];

test.provider(
  "Effect logs reach the console method of their level as one object, unless the Worker registers a logger",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { url, overrideUrl } = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* WorkersLoggerWorker;
          const override = yield* WorkersLoggerOverrideWorker;
          return { url: worker.url.as<string>(), overrideUrl: override.url.as<string>() };
        }),
      );
      expect(url).toMatch(/^http:\/\/localhost:\d+$/);

      expect(yield* getCalls(`${url}/`)).toEqual(everyLevel);
      expect(yield* getCalls(`${url}/durable-object`)).toEqual(everyLevel);

      // A logger registered through `Telemetry.layer` replaces the default.
      expect(yield* getCalls(`${overrideUrl}/`)).toEqual(
        [
          ["Fatal", "fatal"],
          ["Error", "error"],
          ["Warn", "warning"],
          ["Info", "info"],
          ["Debug", "debug"],
          ["Trace", "trace"],
        ].map(([level, message]) => ({ method: "log", args: [[level, [message]]] })),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"],
    timeout: 180_000,
  },
);
