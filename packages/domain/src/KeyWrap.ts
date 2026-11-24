import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { VaultError } from "./VaultError.ts";

/** A subject's new key: `key` encrypts, and `wrapped` is what a {@link KeyStore} keeps of it. */
export interface WrappedKey {
  /** The AES-256 key, as base64 text. It is never stored. */
  readonly key: string;
  /** The key as it is stored: encrypted under a root key, or as it is. */
  readonly wrapped: string;
}

/**
 * Makes each subject's key, and turns it into the text a {@link KeyStore}
 * keeps. A wrap that encrypts under a root key leaves the store holding
 * nothing that opens a value on its own.
 */
export class KeyWrap extends Context.Service<
  KeyWrap,
  {
    /** A new key for a subject, with the text to store for it. */
    readonly make: (subject: string) => Effect.Effect<WrappedKey, VaultError, RuntimeContext>;
    /** The key inside a stored text. It fails when the text was not wrapped for this subject. */
    readonly unwrap: (
      subject: string,
      wrapped: string,
    ) => Effect.Effect<string, VaultError, RuntimeContext>;
  }
>()("alchemy/Domain/KeyWrap") {}

/** @internal */
export const toBase64 = (bytes: Uint8Array): string => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

/** @internal */
export const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

const encoder = new TextEncoder();

/** @internal */
export const failed = (subject: string, reason: string) => () =>
  VaultError.make({ subject, reason });

/** @internal */
export const importAes = (subject: string, key: Uint8Array<ArrayBuffer>) =>
  Effect.tryPromise({
    try: () => crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]),
    catch: failed(subject, "its key is not an AES key"),
  });

/** Encrypt `plain` for `subject` under `key`: `<iv>.<ciphertext>`, bound to the subject. */
/** @internal */
export const encryptFor = Effect.fn(function* (
  subject: string,
  key: CryptoKey,
  plain: Uint8Array<ArrayBuffer>,
) {
  const iv = yield* Effect.sync(() => crypto.getRandomValues(new Uint8Array(12)));
  const sealed = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: encoder.encode(subject) },
        key,
        plain,
      ),
    catch: failed(subject, "the value could not be encrypted"),
  });
  return `${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
});

/** What {@link encryptFor} made, or `None` when `key` is not the one it was made under. */
/** @internal */
export const decryptFor = (subject: string, key: CryptoKey, iv: string, sealed: string) =>
  Effect.tryPromise(() =>
    crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv), additionalData: encoder.encode(subject) },
      key,
      fromBase64(sealed),
    ),
  ).pipe(
    Effect.map((plain) => Option.some(new Uint8Array(plain))),
    Effect.orElseSucceed(() => Option.none<Uint8Array<ArrayBuffer>>()),
  );

/** A new AES-256 key, as base64 text. @internal */
export const newKey = Effect.sync(() => toBase64(crypto.getRandomValues(new Uint8Array(32))));

const ROOT = "r1.";

/**
 * A {@link KeyWrap} that encrypts each subject's key with AES-256-GCM under
 * a root key read by `root`. The root key is any high-entropy secret, such as
 * 32 random bytes as text; it is read on each call, so a rotated secret is
 * picked up.
 *
 * @internal
 */
export const rootKeyWrap = <E>(
  root: Effect.Effect<Redacted.Redacted<string>, E, RuntimeContext>,
): KeyWrap["Service"] => {
  // Derived once per root value: the same secret is the same AES key.
  const derived = new Map<string, CryptoKey>();
  const rootKey = Effect.fn(function* (subject: string) {
    const secret = Redacted.value(
      yield* root.pipe(Effect.mapError(failed(subject, "the root key could not be read"))),
    );
    const known = derived.get(secret);
    if (known !== undefined) return known;
    const digest = yield* Effect.tryPromise({
      try: () => crypto.subtle.digest("SHA-256", encoder.encode(secret)),
      catch: failed(subject, "the root key could not be derived"),
    });
    const key = yield* importAes(subject, new Uint8Array(digest));
    derived.set(secret, key);
    return key;
  });
  return {
    make: Effect.fn(function* (subject) {
      const key = yield* newKey;
      const wrapped = yield* encryptFor(subject, yield* rootKey(subject), fromBase64(key));
      return { key, wrapped: ROOT + wrapped };
    }),
    unwrap: Effect.fn(function* (subject, wrapped) {
      const [version, iv, sealed] = wrapped.split(".");
      if (`${version}.` !== ROOT || iv === undefined || sealed === undefined) {
        return yield* VaultError.make({ subject, reason: "its key was not wrapped by a root key" });
      }
      const key = yield* decryptFor(subject, yield* rootKey(subject), iv, sealed);
      if (Option.isNone(key)) {
        return yield* VaultError.make({
          subject,
          reason: "its key does not unwrap under this root key",
        });
      }
      return toBase64(key.value);
    }),
  };
};
