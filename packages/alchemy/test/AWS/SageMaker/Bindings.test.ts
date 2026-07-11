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

import SageMakerTestFunctionLive, { SageMakerTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SageMakerBindings");

const readinessPolicy = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(75)),
);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry only transient 5xx (cold re-inits under parallel-suite load);
// genuine 4xx/assertion failures surface immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(6)),
      ),
    }),
  );

describe("SageMaker FeatureStore Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("SageMaker bindings: destroying previous stack");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("SageMaker bindings: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SageMakerTestFunction;
        }).pipe(Effect.provide(SageMakerTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* Effect.logInfo(
        `SageMaker bindings: probing readiness at ${baseUrl}/health`,
      );
      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 480_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  describe("PutRecord", () => {
    test.provider(
      "writes a record to the online store",
      () =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.post(`${baseUrl}/put-record`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                userId: "user-put-1",
                clicks: 7,
              }),
            ),
          );
          expect(response.status).toBe(200);
          const body = (yield* response.json) as { success: boolean };
          expect(body.success).toBe(true);
        }),
      { timeout: 60_000 },
    );
  });

  describe("GetRecord", () => {
    test.provider(
      "reads back a written record",
      () =>
        Effect.gen(function* () {
          const put = yield* send(
            HttpClientRequest.post(`${baseUrl}/put-record`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                userId: "user-roundtrip-1",
                clicks: 42,
              }),
            ),
          );
          expect(put.status).toBe(200);

          const get = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/get-record?userId=user-roundtrip-1`,
            ),
          );
          expect(get.status).toBe(200);
          const body = (yield* get.json) as {
            record: { FeatureName?: string; ValueAsString?: string }[];
          };
          const byName = Object.fromEntries(
            body.record.map((f) => [f.FeatureName, f.ValueAsString]),
          );
          expect(byName.user_id).toBe("user-roundtrip-1");
          expect(byName.clicks).toBe("42");
        }),
      { timeout: 60_000 },
    );

    test.provider(
      "returns an empty record for an unknown identifier",
      () =>
        Effect.gen(function* () {
          const get = yield* send(
            HttpClientRequest.get(
              `${baseUrl}/get-record?userId=user-never-written`,
            ),
          );
          expect(get.status).toBe(200);
          const body = (yield* get.json) as { record: unknown[] };
          expect(body.record).toEqual([]);
        }),
      { timeout: 60_000 },
    );
  });
});
