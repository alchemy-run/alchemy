import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { StateStoreError } from "./State.ts";
import {
  type SealingScope,
  StateEncryption,
  type StateEncryptionService,
} from "./StateEncryption.ts";

export interface PassphraseEncryptionOptions {
  /**
   * The passphrase data keys are wrapped with.
   *
   * @default `Config.Redacted("ALCHEMY_STATE_PASSPHRASE")`
   */
  readonly passphrase?: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>;
  /**
   * Turn encryption off: write secrets in plaintext again, and decrypt each
   * stage's secrets as it loads. Deploy every stage with this set, then
   * remove the layer.
   *
   * @default false
   */
  readonly disable?: boolean;
}

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** scrypt cost: 2^15 iterations, about 32 MiB and tens of milliseconds per key. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/** Binds a wrapped data key to its stage, as KMS's encryption context does. */
const aad = (scope: SealingScope) => Buffer.from(`alchemy:${scope.stack}\u0000${scope.stage}`);

const failure = (message: string) => new StateStoreError({ message });

/**
 * Encrypt the secrets in any state store with a passphrase.
 *
 * Each secret (a `Redacted` value: a minted token, a `Random` value) is
 * encrypted with AES-256-GCM under a data key before the store writes it, so
 * the store only ever holds ciphertext. The data key is wrapped with a key
 * derived from the passphrase by scrypt, and bound to its stack and stage. A
 * deploy derives one key per stage it writes, so the cost doesn't grow with
 * the number of secrets.
 *
 * Whoever has the passphrase can read every secret, and losing it loses
 * them, so keep it in a secret manager and hand it to deploys as a secret.
 * A key service such as AWS KMS (`AWS.stateEncryption()`) avoids sharing a
 * passphrase at all: access is an IAM grant, can be scoped to one stage,
 * and is logged.
 *
 * ### Encrypting with a Passphrase
 * **Example:** Cloudflare state, passphrase from `ALCHEMY_STATE_PASSPHRASE`
 * ```typescript
 * import { passphraseEncryption } from "alchemy/State/PassphraseEncryption";
 *
 * state: Cloudflare.state().pipe(Layer.provide(passphraseEncryption())),
 * ```
 *
 * **Example:** Passphrase from another config key
 * ```typescript
 * state: localState().pipe(
 *   Layer.provide(passphraseEncryption({ passphrase: Config.Redacted("STATE_KEY") })),
 * ),
 * ```
 *
 * @layer
 * @provides StateEncryption
 */
export const passphraseEncryption = (options: PassphraseEncryptionOptions = {}) =>
  Layer.effect(
    StateEncryption,
    Effect.gen(function* () {
      const source = options.passphrase ?? Config.Redacted("ALCHEMY_STATE_PASSPHRASE");
      const passphrase = Config.isConfig(source)
        ? yield* source.pipe(
            Effect.mapError((cause) =>
              failure(
                `State encryption needs a passphrase: ${cause.message}. Set ALCHEMY_STATE_PASSPHRASE, or pass one to passphraseEncryption().`,
              ),
            ),
          )
        : source;
      if (Redacted.value(passphrase).length === 0) {
        return yield* failure("The state encryption passphrase is empty");
      }

      // One derived key per salt: a store wraps every data key it mints
      // with the same salt, so it derives once; a reader derives once per
      // salt it meets.
      const writeSalt = yield* Effect.sync(() => randomBytes(SALT_BYTES));
      const derived = new Map<string, Buffer>();
      const deriveKey = (salt: Buffer) =>
        Effect.sync(() => {
          const id = salt.toString("base64");
          const cached = derived.get(id);
          if (cached !== undefined) return cached;
          const key = scryptSync(Redacted.value(passphrase), salt, 32, SCRYPT);
          derived.set(id, key);
          return key;
        });

      const service: StateEncryptionService = {
        id: "passphrase",
        decryptOnly: options.disable === true,
        generate: (scope) =>
          deriveKey(writeSalt).pipe(
            Effect.flatMap((kek) =>
              Effect.try({
                try: () => {
                  const plaintext = randomBytes(32);
                  const iv = randomBytes(IV_BYTES);
                  const cipher = createCipheriv("aes-256-gcm", kek, iv).setAAD(aad(scope));
                  const wrapped = Buffer.concat([
                    writeSalt,
                    iv,
                    cipher.update(plaintext),
                    cipher.final(),
                    cipher.getAuthTag(),
                  ]).toString("base64");
                  return { plaintext: new Uint8Array(plaintext), wrapped };
                },
                catch: () => failure("Could not create a state data key"),
              }),
            ),
          ),
        unwrap: Effect.fn(function* (wrapped: string, scope: SealingScope) {
          const bytes = Buffer.from(wrapped, "base64");
          if (bytes.length < SALT_BYTES + IV_BYTES + TAG_BYTES) {
            return yield* failure("A state data key is truncated");
          }
          const kek = yield* deriveKey(bytes.subarray(0, SALT_BYTES));
          return yield* Effect.try({
            try: () => {
              const decipher = createDecipheriv(
                "aes-256-gcm",
                kek,
                bytes.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES),
              )
                .setAAD(aad(scope))
                .setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
              return new Uint8Array(
                Buffer.concat([
                  decipher.update(bytes.subarray(SALT_BYTES + IV_BYTES, bytes.length - TAG_BYTES)),
                  decipher.final(),
                ]),
              );
            },
            catch: () =>
              failure(
                `Could not open the encrypted secrets of '${scope.stack}/${scope.stage}': wrong passphrase, or the state was moved from another stage`,
              ),
          });
        }),
      };
      return service;
    }),
  );
