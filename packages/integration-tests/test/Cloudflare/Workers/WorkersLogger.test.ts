import { workersLogger } from "@alchemy.run/cloudflare/Workers/WorkersLogger";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { logEveryLevel, recordConsole } from "./fixtures/workers-logger/record.ts";

const logged = <A, E>(effect: Effect.Effect<A, E>) =>
  recordConsole(effect.pipe(Effect.provide(Logger.layer([workersLogger]))));

describe(
  "workersLogger",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker"] },
  () => {
    it.effect("writes each level through its console method", () =>
      Effect.gen(function* () {
        const calls = yield* logged(logEveryLevel);
        expect(calls.map(({ method }) => method)).toEqual([
          "error",
          "error",
          "warn",
          "info",
          "debug",
          "debug",
        ]);
      }),
    );

    it.effect("writes one object: the message, annotations, span name and log spans", () =>
      Effect.gen(function* () {
        const calls = yield* logged(
          Effect.logError("payment declined").pipe(
            Effect.annotateLogs({ reason: "card_declined", attempt: 2 }),
            Effect.withLogSpan("charge"),
            Effect.withSpan("checkout.charge"),
          ),
        );
        expect(calls).toEqual([
          {
            method: "error",
            args: [
              {
                message: "payment declined",
                reason: "card_declined",
                attempt: 2,
                spanName: "checkout.charge",
                spans: { charge: expect.any(Number) },
              },
            ],
          },
        ]);
      }),
    );

    it.effect("keeps the message when an annotation has the same name", () =>
      Effect.gen(function* () {
        const calls = yield* logged(
          Effect.logInfo("started").pipe(Effect.annotateLogs({ message: "not the message" })),
        );
        expect(calls).toEqual([{ method: "info", args: [{ message: "started" }] }]);
      }),
    );

    it.effect("carries a logged cause", () =>
      Effect.gen(function* () {
        const calls = yield* logged(Effect.logWarning("refused", Cause.fail("over quota")));
        expect(calls).toMatchObject([
          {
            method: "warn",
            args: [{ message: "refused", cause: expect.stringContaining("over quota") }],
          },
        ]);
      }),
    );
  },
);
