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

import AthenaTestFunctionLive, { AthenaTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AthenaQuery");

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Fresh Lambda role + Athena/S3 permissions propagate eventually — the first
// queries can 500 with AccessDenied under the handler's `Effect.orDie`.
// Retry 5xx only; a genuine 4xx fails immediately.
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
      // Bounded well under the 180s test timeout (~31s of sleeps) so a
      // persistent 500 surfaces its body instead of an opaque timeout.
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(5),
      ]),
    }),
  );

describe("Athena Query", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Athena Query setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "Athena Query setup: deploying bucket -> Glue db/table -> workgroup -> Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AthenaTestFunction;
        }).pipe(Effect.provide(AthenaTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/nope`).pipe(
        Effect.flatMap((response) =>
          response.status === 404
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(75),
          ]),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  // No NO_DESTROY escape hatch here: scratch-stack state is in-memory per
  // process, so a skipped destroy would orphan the whole stack forever.
  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  test.provider(
    "runs SELECT 1 through the binding (execute + poll + results)",
    () =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/select-one`),
        );
        expect(response.status).toBe(200);
        const body = (yield* response.json) as {
          state: string;
          columns: string[];
          rows: string[][];
        };
        expect(body.state).toBe("SUCCEEDED");
        // SELECT 1 → header row then the value row.
        expect(body.rows.at(-1)?.[0]).toBe("1");
      }),
    { timeout: 180_000 },
  );

  test.provider(
    "runs SELECT COUNT(*) over a Glue table on S3 CSV data",
    () =>
      Effect.gen(function* () {
        // Seed the CSV source data first.
        const seeded = yield* send(HttpClientRequest.post(`${baseUrl}/seed`));
        expect(seeded.status).toBe(200);

        const response = yield* send(HttpClientRequest.get(`${baseUrl}/count`));
        expect(response.status).toBe(200);
        const body = (yield* response.json) as {
          state: string;
          columns: string[];
          rows: string[][];
        };
        expect(body.state).toBe("SUCCEEDED");
        // Three CSV rows → COUNT(*) = 3 (last row is the value, first is header).
        expect(body.rows.at(-1)?.[0]).toBe("3");
      }),
    { timeout: 180_000 },
  );
});
