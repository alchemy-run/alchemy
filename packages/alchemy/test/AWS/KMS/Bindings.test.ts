/**
 * KMS binding tests (Encrypt / Decrypt / GenerateDataKey).
 *
 * COST + CLEANUP NOTE — the shared test key:
 * KMS keys cost $1/mo while enabled and have a 7-day minimum pending-deletion
 * window (pending-deletion keys are NOT billed), so this suite neither keeps
 * a permanently-enabled key nor creates a brand-new key per run. The `Key`
 * resource has no user-assignable identity (only a cloud-generated keyId), so
 * it can't be adopted across runs from the scratch stack's in-memory state.
 * Instead the key is acquired/released out-of-band via distilled KMS around
 * the whole suite:
 *
 * - During the run the key is addressed by the deterministic alias
 *   `alias/alchemy-test-bindings` (see `STANDING_KEY_ALIAS` in `handler.ts`).
 * - `beforeAll` (`ensureStandingKey`) reclaims the previous run's key — via
 *   the alias if an interrupted run left it behind, otherwise by the key's
 *   unique description (`STANDING_KEY_DESCRIPTION`) — cancelling its
 *   scheduled deletion and re-creating the alias. Only on the first-ever run
 *   (or >7 days after the last run) does it `createKey`.
 * - `afterAll` (`releaseStandingKey`) deletes the alias and schedules the
 *   key for deletion (7-day window, idempotent) so a passing run leaves no
 *   alias and no enabled/billed key behind — PendingDeletion is KMS's
 *   terminal "deleted" state; keys pending deletion are not billed and
 *   cannot be removed any faster.
 * - The Lambda fixture binds the crypto operations by alias name — the
 *   bindings accept `Key | AliasName`, and the alias form scopes IAM with the
 *   `kms:RequestAlias` condition so the key never needs to live in the stack.
 *
 * The fixture stack (Lambda only) is destroyed normally.
 */
import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import * as kms from "@distilled.cloud/aws/kms";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
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

class CryptoNotAuthorized extends Data.TaggedError("CryptoNotAuthorized") {}

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
 * Unique marker for the shared test key. The alias is deleted at teardown,
 * so this description is what identifies the previous run's (pending-
 * deletion) key for reclaim.
 */
const STANDING_KEY_DESCRIPTION =
  "Shared key for alchemy AWS.KMS binding tests — scheduled for deletion after each run, reclaimed by description (see test/AWS/KMS/Bindings.test.ts)";

/**
 * Find the shared test key by its unique description. Used to reclaim the
 * previous run's key when the alias has already been deleted by
 * {@link releaseStandingKey}.
 */
const findStandingKeyByDescription = Effect.gen(function* () {
  const keys = yield* kms.listKeys.pages({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk).flatMap((page) => page.Keys ?? [])),
  );
  const metadatas = yield* Effect.all(
    keys.map((key) =>
      kms.describeKey({ KeyId: key.KeyId! }).pipe(
        Effect.map((response) => response.KeyMetadata),
        Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
      ),
    ),
    { concurrency: 5 },
  );
  return metadatas.find(
    (metadata) => metadata?.Description === STANDING_KEY_DESCRIPTION,
  );
});

/** Converge an existing (possibly pending-deletion/disabled) key to enabled. */
const reviveKey = Effect.fn(function* (metadata: kms.KeyMetadata) {
  if (metadata.KeyState === "PendingDeletion") {
    yield* kms.cancelKeyDeletion({ KeyId: metadata.KeyId });
    yield* kms.enableKey({ KeyId: metadata.KeyId });
  } else if (metadata.Enabled === false) {
    yield* kms.enableKey({ KeyId: metadata.KeyId });
  }
});

/**
 * Acquire the shared test key: reclaim the previous run's key (cancelling
 * its scheduled deletion and re-creating the alias), or create it on the
 * first-ever run. Paired with {@link releaseStandingKey} in `afterAll`.
 */
const ensureStandingKey = Effect.gen(function* () {
  const existing = yield* kms.describeKey({ KeyId: STANDING_KEY_ALIAS }).pipe(
    Effect.map((response) => response.KeyMetadata),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );

  if (existing?.KeyId) {
    // The alias survived (a previous run was interrupted before release, or
    // external interference disabled the key) — converge to enabled.
    yield* reviveKey(existing);
    return existing.KeyId;
  }

  // Alias absent — the normal case after a clean release. Reclaim the
  // previous run's pending-deletion key by its unique description before
  // resorting to creating a new one.
  const reclaimed = yield* findStandingKeyByDescription;
  const keyId = reclaimed?.KeyId
    ? yield* reviveKey(reclaimed).pipe(Effect.map(() => reclaimed.KeyId!))
    : yield* kms
        .createKey({
          Description: STANDING_KEY_DESCRIPTION,
          Tags: [
            { TagKey: "alchemy:standing-fixture", TagValue: "kms-bindings" },
          ],
        })
        .pipe(
          Effect.flatMap((created) =>
            created.KeyMetadata?.KeyId
              ? Effect.succeed(created.KeyMetadata.KeyId)
              : Effect.die(new Error("createKey returned no key ID")),
          ),
        );

  yield* kms
    .createAlias({ AliasName: STANDING_KEY_ALIAS, TargetKeyId: keyId })
    .pipe(
      Effect.catchTag("AlreadyExistsException", () =>
        // Lost a create race with a parallel run: the alias already points at
        // another key. Schedule ours for deletion so it doesn't become an
        // orphan, and fall through to the alias's actual target.
        kms
          .scheduleKeyDeletion({ KeyId: keyId, PendingWindowInDays: 7 })
          .pipe(Effect.ignore),
      ),
    );
  const described = yield* kms.describeKey({ KeyId: STANDING_KEY_ALIAS });
  return described.KeyMetadata!.KeyId;
});

/**
 * Release the shared test key: delete the alias and schedule the key for
 * deletion (7-day minimum window — KMS keys cannot be hard-deleted) so a
 * passing run leaves no alias and no enabled/billed key behind. Idempotent —
 * tolerates the alias/key already being gone or the key already pending
 * deletion (a concurrent run's release, or a re-run after a partial
 * teardown).
 */
const releaseStandingKey = Effect.gen(function* () {
  const viaAlias = yield* kms.describeKey({ KeyId: STANDING_KEY_ALIAS }).pipe(
    Effect.map((response) => response.KeyMetadata),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );

  yield* kms
    .deleteAlias({ AliasName: STANDING_KEY_ALIAS })
    .pipe(Effect.catchTag("NotFoundException", () => Effect.void));

  // If the alias was already gone (interrupted earlier release), fall back to
  // the description lookup so an enabled key never survives teardown.
  const target = viaAlias ?? (yield* findStandingKeyByDescription);
  if (target?.KeyId && target.KeyState !== "PendingDeletion") {
    yield* kms
      .scheduleKeyDeletion({ KeyId: target.KeyId, PendingWindowInDays: 7 })
      .pipe(
        // Already pending deletion (raced with another run) or already gone.
        Effect.catchTag(
          ["KMSInvalidStateException", "NotFoundException"],
          () => Effect.void,
        ),
      );
  }
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

      // The fresh Lambda role's IAM policy propagates eventually — /ready
      // exercises no KMS permission, so also probe a full encrypt/decrypt
      // round-trip (bounded) before letting the tests run. Without this the
      // first /decrypt occasionally lands before kms:Decrypt is authorized.
      yield* Effect.logInfo("KMS test setup: probing crypto authorization");
      yield* Effect.gen(function* () {
        const probePlaintext = yield* toBase64("kms-iam-propagation-probe");
        const encrypted = (yield* postJson("/encrypt", {
          plaintextBase64: probePlaintext,
        })) as { ciphertextBase64?: string };
        if (!encrypted.ciphertextBase64) {
          return yield* Effect.fail(new CryptoNotAuthorized());
        }
        const decrypted = (yield* postJson("/decrypt", {
          ciphertextBase64: encrypted.ciphertextBase64,
        })) as { ok: boolean };
        if (!decrypted.ok) {
          return yield* Effect.fail(new CryptoNotAuthorized());
        }
      }).pipe(
        Effect.retry({
          while: (error) => error._tag === "CryptoNotAuthorized",
          schedule: Schedule.fixed("2 seconds").pipe(
            Schedule.both(Schedule.recurs(30)),
          ),
        }),
      );
    }),
    { timeout: 240_000 },
  );

  // Release the out-of-band key even if the stack destroy fails — a passing
  // (or failing) run must never leave an enabled KMS key behind.
  afterAll(
    sharedStack
      .destroy()
      .pipe(
        Effect.ensuring(
          Core.withProviders(
            releaseStandingKey,
            testOptions,
            "KMSBindings",
          ).pipe(Effect.orDie),
        ),
      ),
    { timeout: 120_000 },
  );

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
