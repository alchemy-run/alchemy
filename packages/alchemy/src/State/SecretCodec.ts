import * as NodeCrypto from "node:crypto";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

/**
 * Encrypts / decrypts the payload of a `Redacted<T>` value before it is
 * persisted by a state store. When a codec is active, secrets are written
 * as `{ "__secret__": "<ciphertext>" }` envelopes instead of the plaintext
 * `{ "__redacted__": ... }` marker, so state files never contain secret
 * values in the clear.
 *
 * Both operations are synchronous so they can run inside `JSON.stringify`
 * / `JSON.parse` reviver callbacks on the state encode/decode path.
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
 * Build a {@link SecretCodec} from a password.
 *
 * Key derivation is scrypt (N=16384, one-shot at store init); payloads are
 * AES-256-GCM with a random per-value IV, framed as
 * `v1:base64(iv || authTag || ciphertext)`.
 */
export const makeSecretCodec = (
  password: Redacted.Redacted<string>,
): SecretCodec => {
  const key = NodeCrypto.scryptSync(Redacted.value(password), KDF_SALT, 32);
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
          "Failed to decrypt a secret in state. ALCHEMY_PASSWORD does not match the password that wrote this state.",
          { cause },
        );
      }
    },
  };
};

/**
 * Resolve the ambient state-secret codec from the `ALCHEMY_PASSWORD`
 * config value. Returns `undefined` when no password is configured, in
 * which case secrets are persisted with the plaintext
 * `{ "__redacted__": ... }` marker (the historical behavior).
 */
export const resolveSecretCodec: Effect.Effect<SecretCodec | undefined> =
  Config.option(Config.redacted("ALCHEMY_PASSWORD")).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(undefined),
        onSome: (password) => Effect.sync(() => makeSecretCodec(password)),
      }),
    ),
    Effect.orDie,
  );
