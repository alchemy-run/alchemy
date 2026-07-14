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

import PaymentCryptographyTestFunctionLive, {
  PaymentCryptographyTestFunction,
} from "./handler.ts";
import { reapLeakedKeys } from "./reapKeys.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "PaymentCryptoBindings");

// The whole suite deploys real Payment Cryptography keys (billed monthly),
// so it is gated behind AWS_TEST_PAYMENTCRYPTO=1 alongside the Key lifecycle.
const gated = !process.env.AWS_TEST_PAYMENTCRYPTO;

const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(60),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx from cold re-inits; genuine 4xx fails immediately.
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
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

describe.skipIf(gated)("PaymentCryptography Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Pre-clean: schedule deletion for any ACTIVE keys a previously
      // crashed run leaked under this stack's tags (the scratch state is
      // in-memory, so the destroy above cannot see them).
      yield* Core.withProviders(
        reapLeakedKeys([sharedStack.name]),
        testOptions,
        sharedStack.name,
      );

      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* PaymentCryptographyTestFunction;
        }).pipe(Effect.provide(PaymentCryptographyTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }).pipe(Effect.orDie),
    { timeout: 240_000 },
  );

  // Destroy schedules key deletion (mandatory >=3 day window — keys cannot
  // be hard-deleted, DELETE_PENDING is the terminal state a test can reach);
  // the trailing reap catches any key the destroy missed so even a partial
  // failure leaves nothing ACTIVE.
  afterAll(
    sharedStack
      .destroy()
      .pipe(
        Effect.ensuring(
          Core.withProviders(
            reapLeakedKeys([sharedStack.name]),
            testOptions,
            sharedStack.name,
          ),
        ),
        Effect.orDie,
      ),
    { timeout: 120_000 },
  );

  describe("EncryptData", () => {
    test.provider("encrypts hex-encoded plaintext under the key", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/encrypt-decrypt`),
            // "1234567890123456" — one full AES block, hex-encoded
            { plainTextHex: "31323334353637383930313233343536" },
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          keyArn: string;
          cipherText: string;
          plainText: string;
        };

        expect(response.keyArn).toContain(":key/");
        expect(response.cipherText).toBeTruthy();
        expect(response.cipherText).not.toBe(
          "31323334353637383930313233343536",
        );
      }),
    );
  });

  describe("DecryptData", () => {
    test.provider("round-trips ciphertext back to the plaintext", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/encrypt-decrypt`),
            { plainTextHex: "41414141414141414141414141414141" },
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          plainText: string;
        };

        expect(response.plainText.toUpperCase()).toBe(
          "41414141414141414141414141414141",
        );
      }),
    );
  });

  describe("GenerateMac", () => {
    test.provider("generates an HMAC over message data", (_stack) =>
      Effect.gen(function* () {
        const response = (yield* send(
          HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(`${baseUrl}/mac`),
            { messageDataHex: "31323334353637383930313233343536" },
          ),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          mac: string;
        };

        expect(response.mac).toBeTruthy();
        expect(response.mac).toMatch(/^[0-9A-Fa-f]+$/);
      }),
    );
  });

  describe("VerifyMac", () => {
    test.provider(
      "verifies a generated MAC and rejects a tampered one",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.bodyJsonUnsafe(
              HttpClientRequest.post(`${baseUrl}/mac`),
              { messageDataHex: "39393939393939393939393939393939" },
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            verifiedKeyArn: string;
            tampered: string;
          };

          expect(response.verifiedKeyArn).toContain(":key/");
          expect(response.tampered).toBe("verification-failed");
        }),
    );
  });
});
