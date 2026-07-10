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

import SESTestFunctionLive, { SESTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SESBindings");

// The account is in the SES sandbox with no verified identities: sends from
// the fixture's (unverified) domain identity fail with the typed
// MessageRejected tag — that IS the ungated assertion. Set AWS_TEST_SES_FROM
// to a verified from-address to exercise the success path.
const VERIFIED_FROM = process.env.AWS_TEST_SES_FROM;

// A syntactically valid address at the fixture's (unverified) domain
// identity — SES rejects it with the typed MessageRejected tag in sandbox.
const UNVERIFIED_FROM = "noreply@ses-bindings.alchemy-test.example.com";

const readinessPolicy = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(75)),
);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx only; a genuine 4xx/assertion failure surfaces
// immediately.
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

describe("SES Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("SES test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("SES test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SESTestFunction;
        }).pipe(Effect.provide(SESTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/health`;

      yield* Effect.logInfo(
        `SES test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `SES test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );

      // The freshly attached role policy takes a while to propagate through
      // IAM — poll the send route until SES stops answering AccessDenied so
      // the tests below observe the real (sandbox) behavior.
      yield* HttpClient.execute(
        HttpClientRequest.post(
          `${baseUrl}/send-simple?from=${encodeURIComponent(UNVERIFIED_FROM)}`,
        ),
      ).pipe(
        Effect.flatMap((r) => r.json),
        Effect.flatMap((body) =>
          (body as { error?: string }).error === "AccessDeniedException"
            ? Effect.fail(new Error("IAM policy not propagated yet"))
            : Effect.succeed(body),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `SES test setup: send not authorized yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("SendEmail", () => {
    test.provider(
      "sandbox: unverified sender surfaces the typed MessageRejected tag through the binding",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/send-simple?from=${encodeURIComponent(UNVERIFIED_FROM)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            messageId?: string;
            error?: string;
            message?: string;
          };

          // Sandbox + unverified FROM identity: SES rejects the message with
          // the typed MessageRejected error ("Email address is not
          // verified"). This proves the binding wires IAM + request
          // marshalling correctly all the way into the deployed Lambda.
          expect(response.error).toBe("MessageRejected");
          expect(response.message).toContain("not verified");
        }),
    );

    test.provider(
      "sandbox: templated send is rejected with the same typed tag",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/send-template?from=${encodeURIComponent(UNVERIFIED_FROM)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            messageId?: string;
            error?: string;
          };
          expect(response.error).toBe("MessageRejected");
        }),
    );

    test.provider.skipIf(!VERIFIED_FROM)(
      "sends to the mailbox simulator from a verified identity (AWS_TEST_SES_FROM)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/send-simple?from=${encodeURIComponent(VERIFIED_FROM!)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            messageId?: string;
            error?: string;
            message?: string;
          };

          expect(response.error).toBeUndefined();
          expect(response.messageId).toBeTruthy();
        }),
    );

    test.provider.skipIf(!VERIFIED_FROM)(
      "sends without a configuration set (AWS_TEST_SES_FROM)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/send-plain?from=${encodeURIComponent(VERIFIED_FROM!)}`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            messageId?: string;
            error?: string;
          };
          expect(response.error).toBeUndefined();
          expect(response.messageId).toBeTruthy();
        }),
    );
  });
});
