/**
 * KMS binding tests (Encrypt / Decrypt / GenerateDataKey).
 *
 * COST NOTE — standing test key:
 * KMS keys cost $1/mo each and have a 7-day minimum pending-deletion window,
 * so this suite must NOT create-and-delete keys per run. The `Key` resource
 * has no user-assignable identity (only a cloud-generated keyId), so it can't
 * be adopted across runs from the scratch stack's in-memory state. Instead:
 *
 * - One standing key is addressed by the deterministic alias
 *   `alias/alchemy-test-bindings` (see `STANDING_KEY_ALIAS` in `handler.ts`).
 * - `beforeAll` ensures it exists out-of-band via distilled KMS
 *   (`describeKey` on the alias; `createKey` + `createAlias` on the
 *   first-ever run) and NEVER schedules deletion.
 * - The Lambda fixture binds the crypto operations by alias name — the
 *   bindings accept `Key | AliasName`, and the alias form scopes IAM with the
 *   `kms:RequestAlias` condition so the key never needs to live in the stack.
 *
 * The fixture stack (Lambda only) is destroyed normally; the standing key and
 * alias are intentionally left behind.
 */
import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import * as kms from "@distilled.cloud/aws/kms";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import KMSTestFunctionLive, {
  KMSTestFunction,
  STANDING_KEY_ALIAS,
} from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "KMSBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.fixed("2 seconds").pipe(
  Schedule.both(Schedule.recurs(75)),
);

let baseUrl: string;
let standingKeyId: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Cold re-inits under parallel load surface as transient 5xx from the fixture
// — retry those; a genuine 4xx/assertion failure is returned immediately.
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

const postJson = (path: string, body: object) =>
  send(
    HttpClientRequest.bodyJsonUnsafe(
      HttpClientRequest.post(`${baseUrl}${path}`),
      body,
    ),
  ).pipe(Effect.flatMap((response) => response.json));

const toBase64 = (value: string) =>
  Effect.sync(() => Buffer.from(value, "utf8").toString("base64"));

const fromBase64 = (value: string) =>
  Effect.sync(() => Buffer.from(value, "base64").toString("utf8"));

/**
 * Ensure the standing test key exists and is usable. Creates it exactly once
 * per AWS account (first-ever run); never deletes it.
 */
const ensureStandingKey = Effect.gen(function* () {
  const existing = yield* kms.describeKey({ KeyId: STANDING_KEY_ALIAS }).pipe(
    Effect.map((response) => response.KeyMetadata),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );

  if (existing?.KeyId) {
    // Heal external interference — this suite never disables or deletes the
    // standing key itself.
    if (existing.KeyState === "PendingDeletion") {
      yield* kms.cancelKeyDeletion({ KeyId: existing.KeyId });
      yield* kms.enableKey({ KeyId: existing.KeyId });
    } else if (existing.Enabled === false) {
      yield* kms.enableKey({ KeyId: existing.KeyId });
    }
    return existing.KeyId;
  }

  const created = yield* kms.createKey({
    Description:
      "Standing key for alchemy AWS.KMS binding tests — never deleted (see test/AWS/KMS/Bindings.test.ts)",
    Tags: [{ TagKey: "alchemy:standing-fixture", TagValue: "kms-bindings" }],
  });
  const keyId = created.KeyMetadata?.KeyId;
  if (!keyId) {
    return yield* Effect.die(new Error("createKey returned no key ID"));
  }
  yield* kms
    .createAlias({ AliasName: STANDING_KEY_ALIAS, TargetKeyId: keyId })
    .pipe(
      Effect.catchTag("AlreadyExistsException", () =>
        // Lost a create race with a parallel run: the alias already points at
        // another key. Schedule ours for deletion so it doesn't become a
        // $1/mo orphan, and fall through to the alias's actual target.
        kms
          .scheduleKeyDeletion({ KeyId: keyId, PendingWindowInDays: 7 })
          .pipe(Effect.ignore),
      ),
    );
  const described = yield* kms.describeKey({ KeyId: STANDING_KEY_ALIAS });
  return described.KeyMetadata!.KeyId;
});

describe("KMS Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("KMS test setup: ensuring standing key");
      // `beforeAll` doesn't run inside `test.provider`'s environment, so
      // provide the AWS providers (Credentials/Region) explicitly for the
      // out-of-band distilled calls.
      standingKeyId = yield* Core.withProviders(
        ensureStandingKey,
        testOptions,
        "KMSBindings",
      );
      yield* Effect.logInfo(
        `KMS test setup: standing key ${standingKeyId} (${STANDING_KEY_ALIAS})`,
      );

      yield* Effect.logInfo("KMS test setup: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("KMS test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* KMSTestFunction;
        }).pipe(Effect.provide(KMSTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      yield* Effect.logInfo(
        `KMS test setup: probing readiness at ${baseUrl}/ready`,
      );
      yield* HttpClient.get(`${baseUrl}/ready`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 60_000 });

  describe("Encrypt", () => {
    test.provider("encrypts a payload under the standing key", (_stack) =>
      Effect.gen(function* () {
        const plaintextBase64 = yield* toBase64("alchemy kms encrypt");
        const response = (yield* postJson("/encrypt", {
          plaintextBase64,
        })) as { keyId?: string; ciphertextBase64?: string };

        expect(response.ciphertextBase64).toBeTruthy();
        expect(response.ciphertextBase64).not.toEqual(plaintextBase64);
        // KMS resolves the alias and reports the backing key ARN.
        expect(response.keyId).toContain(standingKeyId);
      }),
    );
  });

  describe("Decrypt", () => {
    test.provider("round-trips plaintext through encrypt/decrypt", (_stack) =>
      Effect.gen(function* () {
        const message = "alchemy kms round-trip: attack at dawn";
        const encrypted = (yield* postJson("/encrypt", {
          plaintextBase64: yield* toBase64(message),
          context: { tenant: "alchemy-test" },
        })) as { ciphertextBase64: string };

        const decrypted = (yield* postJson("/decrypt", {
          ciphertextBase64: encrypted.ciphertextBase64,
          context: { tenant: "alchemy-test" },
        })) as { ok: boolean; keyId?: string; plaintextBase64?: string };

        expect(decrypted.ok).toBe(true);
        expect(yield* fromBase64(decrypted.plaintextBase64!)).toEqual(message);
        expect(decrypted.keyId).toContain(standingKeyId);
      }),
    );

    test.provider(
      "fails with a typed InvalidCiphertextException on context mismatch",
      (_stack) =>
        Effect.gen(function* () {
          const encrypted = (yield* postJson("/encrypt", {
            plaintextBase64: yield* toBase64("context-bound secret"),
            context: { tenant: "alpha" },
          })) as { ciphertextBase64: string };

          const decrypted = (yield* postJson("/decrypt", {
            ciphertextBase64: encrypted.ciphertextBase64,
            context: { tenant: "beta" },
          })) as { ok: boolean; error?: string };

          expect(decrypted.ok).toBe(false);
          expect(decrypted.error).toEqual("InvalidCiphertextException");
        }),
    );
  });

  describe("GenerateDataKey", () => {
    test.provider(
      "returns a plaintext data key whose ciphertext blob decrypts back",
      (_stack) =>
        Effect.gen(function* () {
          const generated = (yield* postJson("/generate-data-key", {})) as {
            keyId?: string;
            plaintextBase64?: string;
            ciphertextBase64?: string;
          };

          expect(generated.plaintextBase64).toBeTruthy();
          expect(generated.ciphertextBase64).toBeTruthy();
          expect(generated.keyId).toContain(standingKeyId);
          // AES_256 data key = 32 bytes.
          const dataKey = yield* Effect.sync(() =>
            Buffer.from(generated.plaintextBase64!, "base64"),
          );
          expect(dataKey.length).toBe(32);

          // The encrypted copy must decrypt (via the Decrypt binding) back to
          // the exact plaintext data key.
          const decrypted = (yield* postJson("/decrypt", {
            ciphertextBase64: generated.ciphertextBase64,
          })) as { ok: boolean; plaintextBase64?: string };

          expect(decrypted.ok).toBe(true);
          expect(decrypted.plaintextBase64).toEqual(generated.plaintextBase64);
        }),
    );
  });

  describe("least privilege", () => {
    test.provider(
      "the role only receives the bound actions (kms:DescribeKey is denied)",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.get(`${baseUrl}/unauthorized`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            ok: boolean;
            error?: string;
          };

          expect(response.ok).toBe(false);
          expect(response.error).toEqual("AccessDeniedException");
        }),
    );
  });
});
