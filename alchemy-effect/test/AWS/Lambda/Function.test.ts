import * as AWS from "@/AWS";
import { destroy } from "@/Destroy";
import { test } from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

import Function from "./handler";

test(
  "create, update, delete function",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* destroy();

    const { functionUrl } = yield* test.deploy(
      Effect.gen(function* () {
        return yield* Function;
      }),
    );

    expect(functionUrl).toBeTruthy();

    const response = yield* HttpClient.get(functionUrl!).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.succeed(response)
          : Effect.fail(new Error(`Function URL returned ${response.status}`)),
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

    yield* destroy();
  }).pipe(Effect.provide(AWS.providers())) as Effect.Effect<void, any, any>,
);
