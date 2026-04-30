import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { TestFunction, TestFunctionLive } from "./handler.ts";

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create, update, delete function",
  (stack) =>
    Effect.gen(function* () {
      const { functionUrl } = yield* stack.deploy(
        TestFunction.asEffect().pipe(Effect.provide(TestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();

      const response = yield* HttpClient.get(functionUrl!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(
                new Error(`Function URL returned ${response.status}`),
              ),
        ),
        Effect.tapError((error) => Effect.logError(error)),
        Effect.retry({
          schedule: Schedule.exponential(500).pipe(
            Schedule.both(Schedule.recurs(10)),
          ),
        }),
      );

      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("Hello, world!");

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);
