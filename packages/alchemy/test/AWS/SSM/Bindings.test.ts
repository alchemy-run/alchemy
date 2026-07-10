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

import SSMTestFunctionLive, { SSMTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SSMBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load. Budget ~150s of
// readiness polling.
const readinessPolicy = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(75)),
);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// parallel load (cold re-init, IAM propagation). Retry 5xx only; a genuine
// 4xx/assertion failure surfaces immediately.
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

describe("SSM Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("SSM test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("SSM test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SSMTestFunction;
        }).pipe(Effect.provide(SSMTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/get-string`;

      yield* Effect.logInfo(
        `SSM test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `SSM test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("GetParameter", () => {
    test.provider("reads a String parameter through the binding", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(`${baseUrl}/get-string`),
        ).pipe(Effect.flatMap((r) => r.json));

        expect((response as any).type).toBe("String");
        expect((response as any).value).toBe("plain-config-value");
      }),
    );

    test.provider(
      "decrypts a SecureString parameter through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/get-secure`),
          ).pipe(Effect.flatMap((r) => r.json));

          expect((response as any).type).toBe("SecureString");
          expect((response as any).value).toBe("bound-secret-value");
        }),
    );
  });

  describe("GetParameters", () => {
    test.provider(
      "reads String and SecureString parameters in one call",
      (_stack) =>
        Effect.gen(function* () {
          const response = yield* send(
            HttpClientRequest.get(`${baseUrl}/get-many`),
          ).pipe(Effect.flatMap((r) => r.json));

          const parameters = (response as any).parameters as Array<{
            name: string;
            type: string;
            value: string;
          }>;
          expect((response as any).invalidParameters).toEqual([]);
          expect(parameters).toHaveLength(2);
          const values = parameters.map((p) => p.value).sort();
          expect(values).toEqual(
            ["bound-secret-value", "plain-config-value"].sort(),
          );
        }),
    );
  });
});
