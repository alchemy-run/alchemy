import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
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

/** How a KMS key wrap keeps an intermediate key. See `DomainAWS.KmsKeyWrap`. */
export interface IntermediateKeyOptions {
  /**
   * How long a process keeps an intermediate key in memory: the one it wraps
   * new subject keys under, and each one it has unwrapped. A process whose
   * access to KMS is revoked can still read for this long.
   */
  readonly keep: Duration.Input;
}

const INTERMEDIATE = "i1.";

/** Unwrapped intermediate keys a process holds at most, oldest dropped first. */
const MAX_KEPT = 1000;

/**
 * A {@link KeyWrap} that calls a key service once per intermediate key
 * rather than once per subject. A process makes an intermediate key, has the
 * service wrap it, and wraps each new subject key under it locally for
 * `keep`. What is stored for a subject carries the wrapped intermediate key,
 * so any process opens it with one call to the service, and keeps the
 * result for `keep`.
 *
 * @internal
 */
export const intermediateKeyWrap = (options: {
  readonly keep: Duration.Input;
  /** A new intermediate key (base64), and what the service wrapped it as (no `.` in it). */
  readonly make: (subject: string) => Effect.Effect<WrappedKey, VaultError>;
  /** The intermediate key (base64) inside what the service wrapped. */
  readonly unwrap: (subject: string, wrapped: string) => Effect.Effect<string, VaultError>;
  /** Unwrap a key stored before the intermediate key was turned on. */
  readonly direct: (subject: string, wrapped: string) => Effect.Effect<string, VaultError>;
}): {
  readonly make: (subject: string) => Effect.Effect<WrappedKey, VaultError>;
  readonly unwrap: (subject: string, wrapped: string) => Effect.Effect<string, VaultError>;
} => {
  const keep = Duration.toMillis(Duration.fromInputUnsafe(options.keep));
  // The key this process wraps new subject keys under.
  let current:
    | { readonly wrapped: string; readonly key: CryptoKey; readonly until: number }
    | undefined;
  // Every intermediate key this process has unwrapped, by what the service wrapped it as.
  const kept = new Map<string, { readonly key: CryptoKey; readonly until: number }>();
  const remember = (wrapped: string, key: CryptoKey, until: number) => {
    kept.delete(wrapped);
    kept.set(wrapped, { key, until });
    if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
  };
  const writing = Effect.fn(function* (subject: string) {
    const now = yield* Clock.currentTimeMillis;
    if (current !== undefined && current.until > now) return current;
    const made = yield* options.make(subject);
    const key = yield* importAes(subject, fromBase64(made.key));
    current = { wrapped: made.wrapped, key, until: now + keep };
    remember(made.wrapped, key, now + keep);
    return current;
  });
  const reading = Effect.fn(function* (subject: string, wrapped: string) {
    const now = yield* Clock.currentTimeMillis;
    const known = kept.get(wrapped);
    if (known !== undefined && known.until > now) return known.key;
    const key = yield* importAes(subject, fromBase64(yield* options.unwrap(subject, wrapped)));
    remember(wrapped, key, now + keep);
    return key;
  });
  return {
    make: Effect.fn(function* (subject) {
      const intermediate = yield* writing(subject);
      const key = yield* newKey;
      const sealed = yield* encryptFor(subject, intermediate.key, fromBase64(key));
      return { key, wrapped: `${INTERMEDIATE}${intermediate.wrapped}.${sealed}` };
    }),
    unwrap: Effect.fn(function* (subject, wrapped) {
      if (!wrapped.startsWith(INTERMEDIATE)) return yield* options.direct(subject, wrapped);
      const [, intermediate, iv, sealed] = wrapped.split(".");
      if (intermediate === undefined || iv === undefined || sealed === undefined) {
        return yield* VaultError.make({ subject, reason: "its key is not a wrapped key" });
      }
      const key = yield* decryptFor(subject, yield* reading(subject, intermediate), iv, sealed);
      if (Option.isNone(key)) {
        return yield* VaultError.make({
          subject,
          reason: "its key does not unwrap under its intermediate key",
        });
      }
      return toBase64(key.value);
    }),
  };
};

/** Whether a stored key was wrapped under an intermediate key. @internal */
export const isIntermediate = (wrapped: string): boolean => wrapped.startsWith(INTERMEDIATE);
