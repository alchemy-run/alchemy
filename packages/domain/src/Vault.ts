import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Platform } from "./Platform.ts";

/**
 * A value encrypted under one subject's key. It names the subject and holds
 * the ciphertext. `decide`, `evolve` and views carry it and can't read it.
 */
export interface Sealed<A> {
  /** Whose key it is encrypted under, such as a customer id. */
  readonly subject: string;
  /** The ciphertext, or the value waiting to be sealed. */
  readonly box: string;
  /** The type of the value inside. Never set. */
  readonly "~sealed"?: A;
}

/** A sealed value as it is stored and sent. */
export const SealedJson = Schema.Struct({ subject: Schema.String, box: Schema.String });
export type SealedJson = typeof SealedJson.Type;

/** A field that holds a {@link Sealed} value of `S`. */
export type SealedSchema<S extends Schema.Top> = Schema.Codec<Sealed<S["Type"]>, SealedJson> & {
  /** The schema of the value inside. */
  readonly value: S;
  /**
   * A value to be sealed for `subject`. It is plain text until a command
   * carries it into the model, which seals it before anything is stored.
   */
  readonly plain: (subject: string, value: S["Type"]) => Sealed<S["Type"]>;
};

/** Any sealed field. */
export type AnySealed = SealedSchema<Schema.Top>;

const PLAIN = "plain.";
const CLEAR = "clear.";
const AES = "v1.";

/** Whether a sealed value is still plain text: made with `plain`, and not yet through a command. */
export const isPlain = (sealed: SealedJson): boolean => sealed.box.startsWith(PLAIN);

/**
 * A field whose value is encrypted under a key kept per subject. Deleting
 * the subject's key makes every copy unreadable, wherever it was stored.
 *
 * ### Declaring a sealed field
 * **Example:** A customer's name
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as Schema from "effect/Schema";
import { Platform } from "./Platform.ts";
 *
 * export const Name = Domain.Sealed(Schema.String);
 *
 * export class CustomerRegistered extends Domain.Event("CustomerRegistered", { name: Name }) {}
 * ```
 *
 * ### Sending a value to be sealed
 * A client sends the value with the subject it belongs to. The model seals
 * it when the command arrives, before anything is stored.
 *
 * **Example:** Registering a customer
 * ```typescript
 * yield* bank.RegisterCustomer({ customerId, name: Name.plain(customerId, "Sam") });
 * ```
 *
 * @primitive
 */
export const make = <S extends Schema.Top>(value: S): SealedSchema<S> => {
  const json = Schema.toCodecJson(value as Schema.Top) as unknown as Schema.Codec<unknown, unknown>;
  // oxlint-disable-next-line effecttsgo/schema-sync -- `plain` builds a value in a client, where nothing is an Effect
  const encode = Schema.encodeUnknownSync(json);
  return Object.assign(SealedJson.annotate({}), {
    value,
    plain: (subject: string, plain: S["Type"]) => ({
      subject,
      box: PLAIN + JSON.stringify(encode(plain)),
    }),
  }) as unknown as SealedSchema<S>;
};

/** The Vault or its key store failed: a key could not be read, or a box is not one of this vault's. */
export class VaultError extends Schema.TaggedError<VaultError>()("VaultError", {
  subject: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Vault: ${this.reason} (subject ${this.subject})`;
  }
}

/**
 * A command carried a value to be sealed, and the model has no Vault. Nothing
 * was stored.
 */
export class VaultMissing extends Schema.TaggedError<VaultMissing>()("VaultMissing", {
  subject: Schema.String,
}) {
  override get message() {
    return `A value for ${this.subject} is waiting to be sealed, and the model has no Vault: provide Domain.VaultLive to the model's Layer`;
  }
}

/** A value reached the model's storage as plain text: it was made with `plain` outside a command. */
export class Unsealed extends Schema.TaggedError<Unsealed>()("Unsealed", {
  subject: Schema.String,
  event: Schema.String,
}) {
  override get message() {
    return `${this.event} holds a value for ${this.subject} that was never sealed: seal it with the Vault, or send it in a command`;
  }
}

/**
 * Where a Vault keeps one key per subject, as the text {@link KeyWrap} made
 * of it. Its methods may need the runtime they run in (`RuntimeContext`), as
 * a database binding does.
 *
 * A backup of the store that is restored brings shredded keys back: keep it
 * somewhere whose backups you control, apart from the model's own.
 *
 * ### Writing a key store
 * **Example:** Keys in a table of your own
 * ```typescript
 * export const MyKeyStore = Layer.effect(
 *   Domain.KeyStore,
 *   Effect.gen(function* () {
 *     const table = yield* Keys;
 *     return {
 *       get: (subject) => table.find(subject),
 *       // The first key stored for a subject wins: return the one it has now.
 *       create: (subject, key) => table.insertIfAbsent(subject, key),
 *       delete: (subject) => table.remove(subject),
 *     };
 *   }),
 * );
 * ```
 */
export class KeyStore extends Context.Service<
  KeyStore,
  {
    /** The subject's stored key, if it has one. */
    readonly get: (
      subject: string,
    ) => Effect.Effect<Option.Option<string>, VaultError, RuntimeContext>;
    /**
     * Store `key` for a subject that has none, and return the key the
     * subject now has: `key`, or the one another caller stored first.
     */
    readonly create: (
      subject: string,
      key: string,
    ) => Effect.Effect<string, VaultError, RuntimeContext>;
    /** Remove the subject's key for good. Removing a key that is not there is not an error. */
    readonly delete: (subject: string) => Effect.Effect<void, VaultError, RuntimeContext>;
  }
>()("alchemy/Domain/KeyStore") {}

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

/**
 * Seals values under a key per subject, opens them, and shreds a subject's
 * key so nothing sealed for them opens again.
 *
 * ### Opening a value
 * A value is opened where it is served, such as a query's handler. It is
 * `None` once its subject is shredded.
 *
 * **Example:** A query that returns a customer's name
 * ```typescript
 * export const CustomerNameLive = CustomerName.toLayer(
 *   Effect.gen(function* () {
 *     const vault = yield* Domain.Vault;
 *     const customers = yield* Customer;
 *     return Effect.fn(function* ({ customerId }) {
 *       const customer = yield* customers.get(customerId);
 *       const name = yield* vault.open(Name, customer.name).pipe(Effect.orDie);
 *       return { name: Option.getOrNull(name) };
 *     });
 *   }),
 * );
 * ```
 *
 * ### Shredding a subject
 * **Example:** Forget a customer
 * ```typescript
 * const vault = yield* Domain.Vault;
 * yield* vault.shred(customerId);
 * ```
 */
export class Vault extends Context.Service<
  Vault,
  {
    /** Encrypt a value under the subject's key, making the key if the subject has none. */
    readonly seal: <S extends Schema.Top>(
      sealed: SealedSchema<S>,
      subject: string,
      value: S["Type"],
    ) => Effect.Effect<Sealed<S["Type"]>, VaultError>;
    /** The value inside, or `None` once its subject's key is shredded. */
    readonly open: <S extends Schema.Top>(
      sealed: SealedSchema<S>,
      value: Sealed<S["Type"]>,
    ) => Effect.Effect<Option.Option<S["Type"]>, VaultError>;
    /** Remove the subject's key. Everything sealed for them stays where it is, unreadable. */
    readonly shred: (subject: string) => Effect.Effect<void, VaultError>;
    /** Seal a value made with `plain`; one already sealed is returned as it is. @internal */
    readonly settle: (sealed: SealedJson) => Effect.Effect<SealedJson, VaultError>;
  }
>()("alchemy/Domain/Vault") {}

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
const decoder = new TextDecoder();

/** The schema-aware half of a Vault, over what encrypts and decrypts text. */
const vaultOver = (text: {
  readonly seal: (subject: string, plain: string) => Effect.Effect<string, VaultError>;
  readonly open: (subject: string, box: string) => Effect.Effect<Option.Option<string>, VaultError>;
  readonly shred: (subject: string) => Effect.Effect<void, VaultError>;
}): Vault["Service"] => {
  const codecOf = (schema: Schema.Top) =>
    Schema.toCodecJson(schema).pipe(Schema.fromJsonString) as unknown as Schema.Codec<
      unknown,
      string
    >;
  const invalid = (subject: string) => () =>
    VaultError.make({ subject, reason: "the value does not match its schema" });
  return {
    seal: Effect.fn(function* (sealed, subject, value) {
      const plain = yield* Schema.encodeUnknownEffect(codecOf(sealed.value))(value).pipe(
        Effect.mapError(invalid(subject)),
      );
      return { subject, box: yield* text.seal(subject, plain) };
    }),
    open: Effect.fn(function* (sealed, value) {
      const plain = value.box.startsWith(PLAIN)
        ? Option.some(value.box.slice(PLAIN.length))
        : yield* text.open(value.subject, value.box);
      if (Option.isNone(plain)) return Option.none();
      return Option.some(
        yield* Schema.decodeEffect(codecOf(sealed.value))(plain.value).pipe(
          Effect.mapError(invalid(value.subject)),
        ),
      );
    }),
    shred: text.shred,
    settle: Effect.fn(function* (sealed) {
      if (!sealed.box.startsWith(PLAIN)) return sealed;
      return {
        subject: sealed.subject,
        box: yield* text.seal(sealed.subject, sealed.box.slice(PLAIN.length)),
      };
    }),
  };
};

/** A subject's key store and key wrap, as the Vault calls them inside the model's runtime. */
interface Keys {
  readonly get: (subject: string) => Effect.Effect<Option.Option<string>, VaultError>;
  readonly create: (subject: string, key: string) => Effect.Effect<string, VaultError>;
  readonly delete: (subject: string) => Effect.Effect<void, VaultError>;
  readonly make: (subject: string) => Effect.Effect<WrappedKey, VaultError>;
  readonly unwrap: (subject: string, wrapped: string) => Effect.Effect<string, VaultError>;
}

const failed = (subject: string, reason: string) => () => VaultError.make({ subject, reason });

const importAes = (subject: string, key: Uint8Array<ArrayBuffer>) =>
  Effect.tryPromise({
    try: () => crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]),
    catch: failed(subject, "its key is not an AES key"),
  });

/** Encrypt `plain` for `subject` under `key`: `<iv>.<ciphertext>`, bound to the subject. */
const encryptFor = Effect.fn(function* (
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
const decryptFor = (subject: string, key: CryptoKey, iv: string, sealed: string) =>
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

/**
 * Keys kept in memory, for tests and local runs: they are gone when the
 * process ends, and with them everything sealed.
 *
 * @layer
 * @provides Domain.KeyStore
 */
export const MemoryKeyStore: Layer.Layer<KeyStore> = Layer.sync(KeyStore, () => memoryKeys());

/** A key store over a map. @internal */
export const memoryKeys = (): KeyStore["Service"] => {
  const keys = new Map<string, string>();
  return {
    get: (subject) => Effect.sync(() => Option.fromNullishOr(keys.get(subject))),
    create: (subject, key) =>
      Effect.sync(() => {
        const existing = keys.get(subject);
        if (existing !== undefined) return existing;
        keys.set(subject, key);
        return key;
      }),
    delete: (subject) => Effect.sync(() => void keys.delete(subject)),
  };
};

/**
 * Keys kept on the model's own host, one object per subject: a Durable
 * Object on Cloudflare, an actor on Rivet, an entity on Effect Cluster, and
 * memory on `Domain.InMemory`. Each key lives in its object's own storage,
 * apart from every aggregate's.
 *
 * **Example:** Keys on Durable Objects
 * ```typescript
 * const Platform = DomainCloudflare.layerDurableObjects();
 *
 * export const BankLive = Bank.layer(BankHandlers).pipe(
 *   Layer.provide(Domain.VaultLive),
 *   Layer.provide(Domain.HostKeyStore),
 *   Layer.provide(Domain.NoKeyWrap),
 *   Layer.provide(Platform),
 * );
 * ```
 *
 * @layer
 * @provides Domain.KeyStore
 */
export const HostKeyStore: Layer.Layer<KeyStore, never, Platform> = Layer.effect(
  KeyStore,
  Effect.flatMap(Platform, (platform) => platform.keys),
);

/**
 * Keys stored as they are, with no root key over them. Whoever can read the
 * {@link KeyStore} can open what it sealed.
 *
 * @layer
 * @provides Domain.KeyWrap
 */
export const NoKeyWrap: Layer.Layer<KeyWrap> = Layer.succeed(KeyWrap, {
  make: () => Effect.map(newKey, (key) => ({ key, wrapped: key })),
  unwrap: (_, wrapped) => Effect.succeed(wrapped),
});

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

/**
 * Wrap each subject's key under a root key you supply, so the
 * {@link KeyStore} alone opens nothing. The root key is a high-entropy
 * secret: 32 random bytes as text, not a password.
 *
 * **Example:** A root key from the environment
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
 * @provides Domain.KeyWrap
 */
export const RootKeyWrap = (
  root: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>,
): Layer.Layer<KeyWrap> =>
  Layer.succeed(
    KeyWrap,
    rootKeyWrap(Redacted.isRedacted(root) ? Effect.succeed(root) : root.pipe(Effect.orDie)),
  );

/**
 * A sealed value as {@link VaultTest} seals it, for a story to expect.
 *
 * **Example:** The event a registration records
 * ```typescript
 * Story.then(sam, new CustomerRegistered({ name: Domain.sealedInTest(Name, sam.id, "Sam") }));
 * ```
 */
export const sealedInTest = <S extends Schema.Top>(
  sealed: SealedSchema<S>,
  subject: string,
  value: S["Type"],
): Sealed<S["Type"]> => ({
  subject,
  box: CLEAR + sealed.plain(subject, value).box.slice(PLAIN.length),
});

/**
 * A Vault for stories. It encrypts nothing, so the same value always seals
 * to the same box and a story can expect it with {@link sealedInTest}. A
 * shredded subject's values no longer open.
 */
export const VaultTest: Layer.Layer<Vault> = Layer.sync(Vault, () => {
  const shredded = new Set<string>();
  return vaultOver({
    seal: (_, plain) => Effect.succeed(CLEAR + plain),
    open: (subject, box) =>
      box.startsWith(CLEAR)
        ? Effect.succeed(
            shredded.has(subject) ? Option.none() : Option.some(box.slice(CLEAR.length)),
          )
        : Effect.fail(
            VaultError.make({ subject, reason: "the box was not sealed by the test vault" }),
          ),
    shred: (subject) => Effect.sync(() => void shredded.add(subject)),
  });
});

const isSealedJson = (value: object): value is SealedJson => {
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    typeof (value as SealedJson).subject === "string" &&
    typeof (value as SealedJson).box === "string"
  );
};

/** The first value in `json` still waiting to be sealed, if any. @internal */
export const findPlain = (json: unknown): SealedJson | undefined => {
  if (typeof json !== "object" || json === null) return undefined;
  if (isSealedJson(json)) return isPlain(json) ? json : undefined;
  for (const value of Array.isArray(json) ? json : Object.values(json)) {
    const found = findPlain(value);
    if (found) return found;
  }
  return undefined;
};

/**
 * Seal every value in `json` that is waiting to be sealed. `json` itself is
 * returned when nothing in it is. @internal
 */
export const settle = (
  json: unknown,
  vault: Option.Option<Vault["Service"]>,
): Effect.Effect<unknown, VaultError | VaultMissing> =>
  Effect.gen(function* () {
    const first = findPlain(json);
    if (first === undefined) return json;
    if (Option.isNone(vault)) return yield* VaultMissing.make({ subject: first.subject });
    const settleAll = (value: unknown): Effect.Effect<unknown, VaultError> => {
      if (typeof value !== "object" || value === null) return Effect.succeed(value);
      if (isSealedJson(value)) return vault.value.settle(value);
      if (Array.isArray(value)) return Effect.forEach(value, settleAll);
      return Effect.map(
        Effect.forEach(Object.entries(value), ([key, inner]) =>
          Effect.map(settleAll(inner), (settled) => [key, settled] as const),
        ),
        Object.fromEntries,
      );
    };
    return yield* settleAll(json);
  });
