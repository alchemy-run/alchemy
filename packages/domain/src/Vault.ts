import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { VaultError } from "./VaultError.ts";

export { VaultError } from "./VaultError.ts";

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
/** The prefix of a box sealed with AES-256-GCM. @internal */
export const AES = "v1.";

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
import { VaultError } from "./VaultError.ts";

export { VaultError } from "./VaultError.ts";
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

/** The schema-aware half of a Vault, over what encrypts and decrypts text. @internal */
export const vaultOver = (text: {
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
