import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as kms from "@distilled.cloud/aws/kms";
import type { Region } from "@distilled.cloud/aws/Region";
import * as Provisioning from "alchemy/State/Provisioning";
import { StateStoreError } from "alchemy/State/State";
import type { SealingScope, StateEncryptionService } from "alchemy/State/StateEncryption";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/**
 * The KMS key an `AWS.stateEncryption()` layer encrypts with. The AWS state
 * stores encrypt their table and buckets at rest with it too.
 */
export class StateKmsKey extends Context.Service<
  StateKmsKey,
  {
    /** The key's ARN, resolved (and for the store's own key, created) once. */
    readonly arn: Effect.Effect<string, StateStoreError>;
  }
>()("AWS/StateKmsKey") {}

/** Context required by the distilled KMS operations. */
type KmsDeps = Credentials | HttpClient | Region;

/**
 * The alias of a state store's own KMS key. The S3 and DynamoDB stores of
 * one name share it, so state moved between them stays readable.
 */
export const createStateKeyAlias = (name?: string) =>
  `alias/alchemy-state${name === undefined ? "" : `-${name}`}`;

/** Starts the description of every key a state store creates. */
export const STATE_KEY_DESCRIPTION = "Alchemy state store key";

/** How long a torn-down store's key waits before KMS deletes it. */
const DELETION_WINDOW_DAYS = 7;

/** A key's metadata, or `undefined` when no key has that id or alias. */
const describeKey = (keyId: string) =>
  kms.describeKey({ KeyId: keyId }).pipe(
    Effect.map((result) => result.KeyMetadata),
    Effect.catchTag("NotFoundException", () => Effect.undefined),
  );

const unusable = (keyId: string, state: string | undefined) =>
  new StateStoreError({
    message: `The state store's KMS key '${keyId}' is ${state ?? "unavailable"}; enable it, or provide AWS.stateEncryption() with another key.`,
  });

/** Turn on yearly rotation of the key material, if it is off. */
const ensureRotation = (keyId: string) =>
  kms
    .getKeyRotationStatus({ KeyId: keyId })
    .pipe(
      Effect.flatMap((status) =>
        status.KeyRotationEnabled ? Effect.void : kms.enableKeyRotation({ KeyId: keyId }),
      ),
    );

/**
 * Observe-then-ensure a state store's own key behind `alias`: create it if
 * missing (tolerating create races), bring it back if it is pending
 * deletion, and turn on rotation. Returns the key's ARN.
 */
export const ensureStateKey = Effect.fn("AWS.state.ensureKey")(function* (alias: string) {
  let metadata = yield* describeKey(alias);
  if (metadata === undefined) {
    yield* Effect.logInfo(`AWS state store: creating KMS key ${alias}`);
    const created = yield* kms.createKey({
      Description: `${STATE_KEY_DESCRIPTION} (${alias})`,
      KeyUsage: "ENCRYPT_DECRYPT",
      KeySpec: "SYMMETRIC_DEFAULT",
    });
    const keyId = created.KeyMetadata?.KeyId;
    if (keyId === undefined) {
      return yield* new StateStoreError({ message: "KMS created a key without an id" });
    }
    const won = yield* kms.createAlias({ AliasName: alias, TargetKeyId: keyId }).pipe(
      Effect.as(true),
      // Another first caller created the alias; use its key, and drop ours.
      Effect.catchTag("AlreadyExistsException", () => Effect.succeed(false)),
    );
    if (!won) {
      yield* kms
        .scheduleKeyDeletion({ KeyId: keyId, PendingWindowInDays: DELETION_WINDOW_DAYS })
        .pipe(Effect.ignore);
    }
    // A just-created alias can briefly describe as missing.
    metadata = yield* describeKey(alias).pipe(
      Effect.repeat({
        until: (found) => found !== undefined,
        schedule: Schedule.spaced("1 second"),
        times: 10,
      }),
    );
    if (metadata === undefined) {
      return yield* new StateStoreError({ message: `KMS alias '${alias}' never became visible` });
    }
  }
  if (metadata.KeyState === "PendingDeletion") {
    // Deleting the key would make every secret sealed under it unreadable.
    yield* Effect.logWarning(
      `AWS state store: KMS key ${alias} was scheduled for deletion; cancelling it, since the state's secrets are sealed under it.`,
    );
    yield* kms.cancelKeyDeletion({ KeyId: metadata.KeyId });
    yield* kms.enableKey({ KeyId: metadata.KeyId });
  } else if (metadata.KeyState !== "Enabled") {
    return yield* unusable(alias, metadata.KeyState);
  }
  if (metadata.Arn === undefined) {
    return yield* new StateStoreError({ message: `KMS key '${alias}' has no ARN` });
  }
  yield* ensureRotation(metadata.Arn);
  return metadata.Arn;
});

/**
 * The ARN of the key a store seals secrets and encrypts at rest with:
 * `kmsKeyId` when given, otherwise the store's own key behind
 * {@link createStateKeyAlias}, created on first use (in CI, only with
 * `--yes`, like the store's other resources).
 */
export const resolveStateKey = Effect.fn("AWS.state.resolveKey")(function* (options: {
  readonly kmsKeyId?: string;
  readonly name?: string;
  readonly store: Provisioning.StoreRef;
}) {
  if (options.kmsKeyId !== undefined) {
    const metadata = yield* describeKey(options.kmsKeyId);
    if (metadata === undefined) {
      return yield* new StateStoreError({
        message: `The state store's KMS key '${options.kmsKeyId}' was not found`,
      });
    }
    if (metadata.KeyState !== "Enabled" || metadata.Arn === undefined) {
      return yield* unusable(options.kmsKeyId, metadata.KeyState);
    }
    return metadata.Arn;
  }
  const alias = createStateKeyAlias(options.name);
  const metadata = yield* describeKey(alias);
  if (metadata?.KeyState === "Enabled" && metadata.Arn !== undefined) return metadata.Arn;
  return yield* Provisioning.deployMissing(
    {
      ...options.store,
      label: `State store KMS key '${alias}'`,
      incomplete: metadata !== undefined,
    },
    ensureStateKey(alias),
  );
});

/**
 * Remove a torn-down store's own key: delete its alias and schedule the key
 * for deletion after {@link DELETION_WINDOW_DAYS} days, which
 * `aws kms cancel-key-deletion` can still undo. A missing key is not an
 * error. Returns the alias when there was a key to remove.
 */
export const removeStateKey = Effect.fn("AWS.state.removeKey")(function* (alias: string) {
  const metadata = yield* describeKey(alias);
  if (metadata === undefined) return undefined;
  yield* kms
    .deleteAlias({ AliasName: alias })
    .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
  if (metadata.KeyState !== "PendingDeletion") {
    yield* kms
      .scheduleKeyDeletion({ KeyId: metadata.KeyId, PendingWindowInDays: DELETION_WINDOW_DAYS })
      .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
  }
  return alias;
});

/** Binds each data key to its stage, so a key policy can grant decrypt per stage. */
const encryptionContext = (scope: SealingScope) => ({
  "alchemy:stack": scope.stack,
  "alchemy:stage": scope.stage,
});

const bytes = (value: Uint8Array | Redacted.Redacted<Uint8Array> | undefined) =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** Names KMS in the records it seals. */
export const KMS_STATE_ENCRYPTION_ID = "aws-kms";

/**
 * State encryption over KMS: data keys from `GenerateDataKey` under
 * `keyArn`, bound to their stage by the encryption context, unwrapped with
 * `Decrypt`. Decrypting reads the key from the wrapped data key itself, so
 * records sealed under an earlier key stay readable.
 */
export const kmsKeyring = (
  keyArn: Effect.Effect<string, StateStoreError>,
  run: <A, E extends { readonly message?: string; readonly _tag?: string }>(
    effect: Effect.Effect<A, E, KmsDeps>,
  ) => Effect.Effect<A, StateStoreError>,
): StateEncryptionService => ({
  id: KMS_STATE_ENCRYPTION_ID,
  generate: (scope) =>
    keyArn.pipe(
      Effect.flatMap((KeyId) =>
        run(
          kms.generateDataKey({
            KeyId,
            KeySpec: "AES_256",
            EncryptionContext: encryptionContext(scope),
          }),
        ),
      ),
      Effect.flatMap((result) => {
        const plaintext = bytes(result.Plaintext);
        return plaintext === undefined || result.CiphertextBlob === undefined
          ? Effect.fail(new StateStoreError({ message: "KMS returned no data key" }))
          : Effect.succeed({
              plaintext,
              wrapped: Buffer.from(result.CiphertextBlob).toString("base64"),
            });
      }),
      Effect.mapError(
        (error) =>
          new StateStoreError({
            message: `Could not create a data key to seal the secrets of '${scope.stack}/${scope.stage}': ${error.message}`,
          }),
      ),
    ),
  unwrap: (wrapped, scope) =>
    run(
      kms.decrypt({
        CiphertextBlob: Buffer.from(wrapped, "base64"),
        EncryptionContext: encryptionContext(scope),
      }),
    ).pipe(
      Effect.flatMap((result) => {
        const plaintext = bytes(result.Plaintext);
        return plaintext === undefined
          ? Effect.fail(new StateStoreError({ message: "KMS returned no plaintext" }))
          : Effect.succeed(plaintext);
      }),
      Effect.mapError(
        (error) =>
          new StateStoreError({
            message: `Could not open the sealed secrets of '${scope.stack}/${scope.stage}' with KMS: ${error.message}`,
          }),
      ),
    ),
});
