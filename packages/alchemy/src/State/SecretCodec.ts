import * as NodeCrypto from "node:crypto";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import { rootDir } from "../Auth/Profile.ts";

/**
 * Encrypts / decrypts the payload of a `Redacted<T>` value before it is
 * persisted by a state store. When a codec is active, secrets are written
 * as `{ "__secret__": "<ciphertext>" }` envelopes instead of the plaintext
 * `{ "__redacted__": ... }` marker, so state files never contain secret
 * values in the clear.
 *
 * Both operations are synchronous so they can run inside `JSON.stringify`
 * / `JSON.parse` reviver callbacks on the state encode/decode path. Key
 * material is therefore obtained *before* codec construction — from
 * `ALCHEMY_PASSWORD`, the local `~/.alchemy/state.key` file, or a KMS
 * data key — and closed over.
 */
export interface SecretCodec {
  readonly encrypt: (plaintext: string) => string;
  readonly decrypt: (payload: string) => string;
}

/** Ciphertext format version prefix. */
const VERSION_PREFIX = "v1:";

/**
 * Fixed KDF context string. The password is expected to be a high-entropy
 * secret (not a memorable human password), so a per-store random salt —
 * which would need its own persistence and rotation story — is not used.
 */
const KDF_SALT = "alchemy-state-secret:v1";

/** AES-GCM recommended IV length. */
const IV_BYTES = 12;

/** AES-GCM auth tag length. */
const TAG_BYTES = 16;

/**
 * Build a {@link SecretCodec} from raw 32-byte key material. Payloads are
 * AES-256-GCM with a random per-value IV, framed as
 * `v1:base64(iv || authTag || ciphertext)`.
 */
export const makeSecretCodecFromKey = (key: Uint8Array): SecretCodec => {
  if (key.length !== 32) {
    throw new Error(
      `State secret key must be 32 bytes (got ${key.length}). The key material may be corrupted.`,
    );
  }
  return {
    encrypt: (plaintext) => {
      const iv = NodeCrypto.randomBytes(IV_BYTES);
      const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return (
        VERSION_PREFIX +
        Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")
      );
    },
    decrypt: (payload) => {
      if (!payload.startsWith(VERSION_PREFIX)) {
        throw new Error(
          `Unrecognized encrypted state secret format (expected "${VERSION_PREFIX}" prefix). The state may have been written by a newer version of alchemy.`,
        );
      }
      const framed = Buffer.from(
        payload.slice(VERSION_PREFIX.length),
        "base64",
      );
      const iv = framed.subarray(0, IV_BYTES);
      const tag = framed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = framed.subarray(IV_BYTES + TAG_BYTES);
      const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString("utf8");
      } catch (cause) {
        throw new Error(
          "Failed to decrypt a secret in state: the configured key does not match the one that wrote this state (check ALCHEMY_PASSWORD, or the state key it was written with).",
          { cause },
        );
      }
    },
  };
};

/**
 * Build a {@link SecretCodec} from a password: scrypt (N=16384, one-shot
 * at store init) derives the AES-256 key.
 */
export const makeSecretCodec = (
  password: Redacted.Redacted<string>,
): SecretCodec =>
  makeSecretCodecFromKey(
    NodeCrypto.scryptSync(Redacted.value(password), KDF_SALT, 32),
  );

/**
 * Read the optional `ALCHEMY_PASSWORD` override. When set, it takes
 * precedence over every automatic key source (local key file, KMS) so
 * teams and CI can pin one shared key across machines and stores.
 */
export const resolveSecretPassword: Effect.Effect<
  Option.Option<Redacted.Redacted<string>>
> = Config.option(Config.redacted("ALCHEMY_PASSWORD")).pipe(Effect.orDie);

/**
 * Resolve the state-secret codec from the `ALCHEMY_PASSWORD` config value
 * alone. Returns `undefined` when no password is configured. Used by
 * stores whose state is shared across machines (HTTP) where an automatic
 * machine-local key would break other readers.
 */
export const resolveSecretCodec: Effect.Effect<SecretCodec | undefined> =
  resolveSecretPassword.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(undefined),
        onSome: (password) => Effect.sync(() => makeSecretCodec(password)),
      }),
    ),
  );

/** File name of the auto-generated local state key under `~/.alchemy`. */
export const localStateKeyFileName = "state.key";

/**
 * Resolve the codec for machine-local state (the `.alchemy/state/` file
 * store): `ALCHEMY_PASSWORD` when set, otherwise an auto-generated
 * 32-byte key persisted at `~/.alchemy/state.key` (created on first use,
 * mode 0600). Always yields a codec — local state is encrypted by
 * default with zero key management.
 *
 * Concurrent first-time creation is safe: the key file is created with
 * the exclusive `wx` flag, and every process then reads back whatever
 * won the race, so all writers converge on one key.
 */
export const resolveLocalSecretCodec: Effect.Effect<
  SecretCodec,
  PlatformError,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const password = yield* resolveSecretPassword;
  if (Option.isSome(password)) {
    return yield* Effect.sync(() => makeSecretCodec(password.value));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const keyFile = path.join(rootDir, localStateKeyFileName);

  const readKey = fs
    .readFileString(keyFile)
    .pipe(
      Effect.map((hex) =>
        makeSecretCodecFromKey(Buffer.from(hex.trim(), "hex")),
      ),
    );

  return yield* readKey.pipe(
    Effect.catchTag("PlatformError", (e) =>
      e.reason._tag !== "NotFound"
        ? Effect.fail(e)
        : Effect.gen(function* () {
            const fresh = yield* Effect.sync(() =>
              Buffer.from(NodeCrypto.randomBytes(32)).toString("hex"),
            );
            yield* fs.makeDirectory(rootDir, { recursive: true });
            // `wx` fails if the file already exists, so a concurrent
            // creator can never be overwritten; the read-back below
            // converges every process on the winning key.
            yield* fs
              .writeFileString(keyFile, `${fresh}\n`, {
                flag: "wx",
                mode: 0o600,
              })
              .pipe(
                Effect.catchTag("PlatformError", (we) =>
                  we.reason._tag === "AlreadyExists"
                    ? Effect.void
                    : Effect.fail(we),
                ),
              );
            return yield* readKey;
          }),
    ),
  );
});
