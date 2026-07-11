import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import LexTestFunctionLive, { LexTestFunction } from "./handler.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "LexV2Bindings");

let baseUrl: string;

// Building the bot locale takes one to a few minutes — the full E2E is gated
// behind AWS_TEST_LEX=1. Run with:
//   AWS_TEST_LEX=1 ALCHEMY_PROFILE=testing bun vitest run test/AWS/LexV2/RecognizeText.test.ts
const gated = !process.env.AWS_TEST_LEX;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

/**
 * POST /recognize with a bounded 5xx retry — the Lambda role's fresh
 * `lex:RecognizeText` policy propagates eventually, surfacing as 502
 * AccessDeniedException for the first seconds.
 */
const recognize = (text: string, sessionId: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}/recognize`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ text, sessionId }),
      ),
    );
    const body = yield* response.text;
    if (response.status >= 500) {
      return yield* Effect.fail(
        new TransientUpstream({ status: response.status, body }),
      );
    }
    expect(response.status).toBe(200);
    return JSON.parse(body) as {
      intent: string | null;
      interpretations: (string | undefined)[];
    };
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.exponential("1 second").pipe(
        Schedule.both(Schedule.recurs(8)),
      ),
    }),
  );

describe.skipIf(gated)("LexV2 Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("LexV2 e2e setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "LexV2 e2e setup: deploying role -> bot -> locale -> intent -> version (build) -> alias -> Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* LexTestFunction;
        }).pipe(Effect.provide(LexTestFunctionLive)),
      );
      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.fixed("2 seconds").pipe(
            Schedule.both(Schedule.recurs(75)),
          ),
        }),
      );
    }),
    // Locale build dominates: ~1-3 minutes on top of the deploy.
    { timeout: 600_000 },
  );
  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  describe("RecognizeText", () => {
    test.provider(
      "recognizes a greeting utterance as the Greet intent",
      () =>
        Effect.gen(function* () {
          const body = yield* recognize("hello", "alchemy-e2e-greet");
          expect(body.intent).toBe("Greet");
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "routes an unmatched utterance to the fallback intent",
      () =>
        Effect.gen(function* () {
          const body = yield* recognize(
            "purple monkey dishwasher",
            "alchemy-e2e-fallback",
          );
          expect(body.intent).toBe("FallbackIntent");
        }),
      { timeout: 120_000 },
    );
  });
});
