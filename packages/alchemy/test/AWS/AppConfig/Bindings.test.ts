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

import AppConfigTestFunctionLive, {
  AppConfigTestFunction,
} from "./fixtures/handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AppConfigBindings");

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Fresh Lambda role + AppConfig permissions propagate eventually — the first
// fetches can 500 with AccessDenied under the handler's `Effect.orDie`. Retry
// 5xx only; a genuine 4xx fails immediately.
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
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(8),
      ]),
    }),
  );

describe("AppConfig Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "AppConfig test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "AppConfig test setup: deploying app -> env -> profile -> version -> deployment -> Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AppConfigTestFunction;
        }).pipe(Effect.provide(AppConfigTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/ping`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
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
  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  describe("GetConfiguration", () => {
    test.provider(
      "the Lambda fetches its deployed configuration through the binding",
      () =>
        Effect.gen(function* () {
          // The data plane may briefly serve an empty body right after the
          // deployment completes; retry until the content is present.
          const body = yield* send(
            HttpClientRequest.get(`${baseUrl}/config`),
          ).pipe(
            Effect.flatMap((response) => response.json),
            Effect.map(
              (json) => json as { content?: string; contentType?: string },
            ),
            Effect.filterOrFail(
              (json) =>
                typeof json.content === "string" && json.content.length > 0,
              () => new Error("configuration not yet available"),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.spaced("3 seconds"),
                Schedule.recurs(20),
              ]),
            }),
          );

          expect(body.contentType).toContain("application/json");
          expect(JSON.parse(body.content!)).toEqual({
            featureX: true,
            limit: 42,
          });
        }),
      { timeout: 180_000 },
    );
  });
});
