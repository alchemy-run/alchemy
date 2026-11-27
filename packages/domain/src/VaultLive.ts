import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { KeyStore } from "./KeyStore.ts";
import {
  decryptFor,
  encryptFor,
  fromBase64,
  importAes,
  KeyWrap,
  type WrappedKey,
} from "./KeyWrap.ts";
import { AES, Vault, vaultOver } from "./Vault.ts";
import { VaultError } from "./VaultError.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A subject's key store and key wrap, as the Vault calls them inside the model's runtime. */
interface Keys {
  readonly get: (subject: string) => Effect.Effect<Option.Option<string>, VaultError>;
  readonly create: (subject: string, key: string) => Effect.Effect<string, VaultError>;
  readonly delete: (subject: string) => Effect.Effect<void, VaultError>;
  readonly make: (subject: string) => Effect.Effect<WrappedKey, VaultError>;
  readonly unwrap: (subject: string, wrapped: string) => Effect.Effect<string, VaultError>;
}

/**
 * A Vault that encrypts with AES-256-GCM under one key per subject. A
 * {@link KeyWrap} makes each key and a {@link KeyStore} keeps it. A box is
 * bound to its subject: under another subject, or under a key the subject
 * got after being shredded, it does not open.
 *
 * ### Giving a model a Vault
 * **Example:** Keys on the model's own host, wrapped under a root key
 * ```typescript
 * export const BankLive = Bank.layer(BankHandlers).pipe(
 *   Layer.provide(Domain.VaultLive),
 *   Layer.provide(Domain.HostKeyStore),
 *   Layer.provide(Domain.RootKeyWrap(Config.Redacted("VAULT_ROOT_KEY"))),
 *   Layer.provide(Platform),
 * );
 * ```
 *
 * @layer
 * @provides Domain.Vault
 */
export const VaultLive: Layer.Layer<Vault, never, KeyStore | KeyWrap> = Layer.effect(
  Vault,
  Effect.gen(function* () {
    // The model runs inside its runtime, which provides RuntimeContext to both.
    const keys = { ...(yield* KeyStore), ...(yield* KeyWrap) } as unknown as Keys;
    const keyOf = Effect.fn(function* (subject: string) {
      const stored = yield* keys.get(subject);
      if (Option.isNone(stored)) return Option.none<string>();
      return Option.some(yield* keys.unwrap(subject, stored.value));
    });
    const keyFor = Effect.fn(function* (subject: string) {
      const existing = yield* keyOf(subject);
      if (Option.isSome(existing)) return existing.value;
      const made = yield* keys.make(subject);
      // Another caller may have stored a key first: seal under the one the subject has.
      const stored = yield* keys.create(subject, made.wrapped);
      return stored === made.wrapped ? made.key : yield* keys.unwrap(subject, stored);
    });
    return vaultOver({
      seal: Effect.fn(function* (subject, plain) {
        const key = yield* importAes(subject, fromBase64(yield* keyFor(subject)));
        return AES + (yield* encryptFor(subject, key, encoder.encode(plain)));
      }),
      open: Effect.fn(function* (subject, box) {
        const [version, iv, sealed] = box.split(".");
        if (`${version}.` !== AES || iv === undefined || sealed === undefined) {
          return yield* VaultError.make({
            subject,
            reason: "the box was not sealed by this vault",
          });
        }
        const key = yield* keyOf(subject);
        if (Option.isNone(key)) return Option.none();
        // A box that does not open with the subject's key was sealed under one
        // that is gone: the subject was shredded, and has a new key since.
        const plain = yield* decryptFor(
          subject,
          yield* importAes(subject, fromBase64(key.value)),
          iv,
          sealed,
        );
        return Option.map(plain, (bytes) => decoder.decode(bytes));
      }),
      shred: keys.delete,
    });
  }),
);
