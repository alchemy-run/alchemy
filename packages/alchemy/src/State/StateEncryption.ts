import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { StateStoreError } from "./State.ts";
import {
  encodeState,
  REDACTED_MARKER,
  reviveState,
  reviveStateRecursive,
} from "./StateEncoding.ts";

/**
 * Client-side envelope encryption of the secrets (`Redacted` values) in
 * persisted state, for any state store.
 *
 * The {@link StateEncryption} service mints and unwraps data keys, e.g. with
 * AWS KMS. Provide it to a store's layer and the store encrypts every secret
 * under a data key before it leaves the process:
 *
 * ```typescript
 * state: Cloudflare.state().pipe(Layer.provide(AWS.stateEncryption())),
 * ```
 *
 * A store minting a data key asks the service once per stage for its
 * lifetime, so a deploy makes one key request per stage however many
 * secrets it writes. Secrets are AES-256-GCM encrypted under it; every other
 * value stays readable, so plans and diffs keep working. A record with no
 * secret is written as it always was.
 *
 * Stores that keep records as text write a sealed record as a header line
 * naming the service and holding the wrapped data key, then the record's
 * JSON with every secret replaced by its ciphertext:
 *
 * ```
 * alchemy:sealed:1:aws-kms:<wrapped data key>
 * {"status":"created","attr":{"password":{"__sealed__":"<iv | ciphertext | tag>"}}}
 * ```
 *
 * The header makes the record invalid JSON on purpose: a version of alchemy
 * from before encryption fails to parse it instead of reading the envelope as
 * the secret. Stores that keep records as JSON values put the same header in
 * a top-level `__alchemy_sealed__` field, and fence older versions out by
 * their store version.
 */

/** Starts every sealed text record. */
export const SEALED_PREFIX = "alchemy:sealed:1:";

/** Marks one sealed secret: `{ [SEALED_MARKER]: base64(iv | ciphertext | tag) }`. */
export const SEALED_MARKER = "__sealed__";

/** Carries a sealed JSON record's header: `{ by, key }`, plus `value` for a non-object. */
export const SEALED_RECORD_MARKER = "__alchemy_sealed__";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The stage a record belongs to. Data keys are bound to it. */
export interface SealingScope {
  readonly stack: string;
  readonly stage: string;
}

/** A data key: its plaintext, and the copy the service wrapped. */
export interface DataKey {
  readonly plaintext: Uint8Array;
  /** The wrapped key, base64. */
  readonly wrapped: string;
}

/** What a {@link StateEncryption} implementation provides. */
export interface StateEncryptionService {
  /**
   * Names the implementation in every record it seals, e.g. `aws-kms`:
   * lowercase letters, digits and hyphens. A store refuses a record another
   * implementation sealed rather than handing it the wrong key.
   */
  readonly id: string;
  /** A fresh 256-bit data key for `scope`'s writes. */
  readonly generate: (scope: SealingScope) => Effect.Effect<DataKey, StateStoreError>;
  /** The plaintext of a data key {@link StateEncryptionService.generate} wrapped for `scope`. */
  readonly unwrap: (
    wrapped: string,
    scope: SealingScope,
  ) => Effect.Effect<Uint8Array, StateStoreError>;
}

/**
 * Encrypts the secrets in state. Provide an implementation to a state store's
 * layer, e.g. `AWS.stateEncryption()`; a store with none writes secrets as
 * it always has (the AWS stores default to their own KMS key).
 */
export class StateEncryption extends Context.Service<StateEncryption, StateEncryptionService>()(
  "alchemy/State/StateEncryption",
) {}

/** How a store turns state values into what it stores, and back. */
export interface StateCodec {
  /** Text for `value`, sealed when it holds a secret. */
  readonly encode: (
    scope: SealingScope,
    value: unknown,
    space?: number,
  ) => Effect.Effect<string, StateStoreError>;
  /** The value of stored text. `what` names it in a failure, e.g. `state object 'a.json'`. */
  readonly decode: <T>(
    scope: SealingScope,
    text: string,
    what: string,
  ) => Effect.Effect<T, StateStoreError>;
  /** A JSON value for `value`, for stores that keep JSON: secrets sealed in place. */
  readonly encodeJson: (
    scope: SealingScope,
    value: unknown,
  ) => Effect.Effect<unknown, StateStoreError>;
  /** The value of a stored JSON value. */
  readonly decodeJson: <T>(
    scope: SealingScope,
    json: unknown,
    what: string,
  ) => Effect.Effect<T, StateStoreError>;
  /** Plain JSON for stored text, every sealed secret opened. */
  readonly open: (scope: SealingScope, text: string) => Effect.Effect<string, StateStoreError>;
  /** Whether stored text keeps a secret in plaintext that {@link StateCodec.encode} would seal. */
  readonly unsealed: (text: string) => boolean;
}

/** Whether stored text is a sealed record. */
export const isSealed = (text: string) => text.startsWith(SEALED_PREFIX);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `{ [marker]: inner }` and nothing else, as `encodeState` writes it. */
const isEnvelope = (value: unknown, marker: string): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === marker;
};

/** Whether an encoded value holds a secret. */
const holdsSecret = (value: unknown): boolean => {
  if (isEnvelope(value, REDACTED_MARKER)) return true;
  if (Array.isArray(value)) return value.some(holdsSecret);
  if (isRecord(value)) return Object.values(value).some(holdsSecret);
  return false;
};

/** Replace every envelope of `marker` in `value` with `f` of its contents. */
const mapEnvelopes = (value: unknown, marker: string, f: (inner: unknown) => unknown): unknown => {
  if (isEnvelope(value, marker)) return f(value[marker]);
  if (Array.isArray(value)) return value.map((item) => mapEnvelopes(item, marker, f));
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) result[k] = mapEnvelopes(v, marker, f);
    return result;
  }
  return value;
};

const sealSecret = (key: Uint8Array, plaintext: string) => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64");
};

const openSecret = (key: Uint8Array, sealed: unknown) => {
  if (typeof sealed !== "string") throw new Error("sealed secret is not a string");
  const bytes = Buffer.from(sealed, "base64");
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error("sealed secret is truncated");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, IV_BYTES));
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
};

const parseError = (what: string, cause: unknown) =>
  new StateStoreError({
    message: `Failed to parse ${what}${cause instanceof Error ? `: ${cause.message}` : ""}`,
    cause: cause instanceof Error ? cause : undefined,
  });

const parsePlain = <T>(text: string, what: string) =>
  Effect.try({
    try: () => JSON.parse(text, reviveState) as T,
    catch: (cause) => parseError(what, cause),
  });

/** Who sealed a record, and its wrapped data key. */
interface SealedHeader {
  readonly by: string;
  readonly key: string;
}

/** A sealed text record's header and JSON body. */
const splitSealed = (text: string): (SealedHeader & { body: string }) | undefined => {
  const newline = text.indexOf("\n", SEALED_PREFIX.length);
  if (newline === -1) return undefined;
  const header = text.slice(SEALED_PREFIX.length, newline);
  const colon = header.indexOf(":");
  if (colon === -1) return undefined;
  return {
    by: header.slice(0, colon),
    key: header.slice(colon + 1),
    body: text.slice(newline + 1),
  };
};

/** A sealed JSON record's header, and its body without it. */
const splitSealedJson = (json: unknown): (SealedHeader & { body: unknown }) | undefined => {
  if (!isRecord(json) || !isRecord(json[SEALED_RECORD_MARKER])) return undefined;
  const { by, key, ...rest } = json[SEALED_RECORD_MARKER];
  if (typeof by !== "string" || typeof key !== "string") return undefined;
  if ("value" in rest) return { by, key, body: rest.value };
  const { [SEALED_RECORD_MARKER]: _, ...body } = json;
  return { by, key, body };
};

const unsealed = (text: string) => {
  if (isSealed(text) || !text.includes(`"${REDACTED_MARKER}"`)) return false;
  try {
    return holdsSecret(JSON.parse(text));
  } catch {
    return false;
  }
};

const noEncryption = (what: string, by: string) =>
  new StateStoreError({
    message: `Failed to read ${what}: its secrets are encrypted with '${by}', and this state store has no StateEncryption to open them. Provide the one that wrote them, e.g. AWS.stateEncryption().`,
  });

/**
 * The codec of a store without {@link StateEncryption}: secrets are written in
 * plaintext, as `{ "__redacted__": <value> }`. A sealed record fails to decode.
 */
export const plainCodec: StateCodec = {
  encode: (_scope, value, space) =>
    Effect.sync(() => JSON.stringify(encodeState(value), null, space)),
  decode: (_scope, text, what) => {
    const sealed = isSealed(text) ? splitSealed(text) : undefined;
    return isSealed(text)
      ? Effect.fail(noEncryption(what, sealed?.by ?? "unknown"))
      : parsePlain(text, what);
  },
  encodeJson: (_scope, value) => Effect.sync(() => encodeState(value)),
  decodeJson: <T>(_scope: SealingScope, json: unknown, what: string) => {
    const sealed = splitSealedJson(json);
    return sealed === undefined
      ? Effect.sync(() => reviveStateRecursive(json) as T)
      : Effect.fail(noEncryption(what, sealed.by));
  },
  open: (_scope, text) =>
    isSealed(text)
      ? Effect.fail(noEncryption("sealed state", splitSealed(text)?.by ?? "unknown"))
      : Effect.succeed(text),
  unsealed: () => false,
};

/**
 * One cached effect per key. A failed effect is dropped rather than cached,
 * so the next call retries it.
 */
const keyedCache = <A>() => {
  const mutex = Semaphore.makeUnsafe(1);
  const entries = new Map<string, Effect.Effect<A, StateStoreError>>();
  return {
    seed: (key: string, value: A) => {
      entries.set(key, Effect.succeed(value));
    },
    get: (key: string, make: Effect.Effect<A, StateStoreError>) =>
      Semaphore.withPermits(
        mutex,
        1,
      )(
        Effect.gen(function* () {
          const existing = entries.get(key);
          if (existing !== undefined) return existing;
          const cached = yield* Effect.cached(
            make.pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  if (entries.get(key) === cached) entries.delete(key);
                }),
              ),
            ),
          );
          entries.set(key, cached);
          return cached;
        }),
      ).pipe(Effect.flatMap((effect) => effect)),
  };
};

const scopeKey = (scope: SealingScope) => `${scope.stack}\u0000${scope.stage}`;

const VALID_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A codec that seals secrets under data keys from `encryption`. It mints one
 * data key per stage for its lifetime, and unwraps each stored data key at
 * most once. Records written in plaintext still decode, so a store can start
 * encrypting with state already in it.
 */
export const makeSealingCodec = (encryption: StateEncryptionService): StateCodec => {
  if (!VALID_ID.test(encryption.id)) {
    throw new Error(
      `Invalid StateEncryption id '${encryption.id}': use lowercase letters, digits and hyphens`,
    );
  }
  const dataKeys = keyedCache<DataKey>();
  const unwrapped = keyedCache<Uint8Array>();

  const dataKey = (scope: SealingScope) =>
    dataKeys.get(
      scopeKey(scope),
      encryption.generate(scope).pipe(
        // Records this store writes decode without asking the service.
        Effect.tap((key) =>
          Effect.sync(() =>
            unwrapped.seed(`${scopeKey(scope)}\u0000${key.wrapped}`, key.plaintext),
          ),
        ),
      ),
    );

  /** The data key of a sealed record, from the service that sealed it. */
  const unwrap = (header: SealedHeader, scope: SealingScope, what: string) =>
    header.by !== encryption.id
      ? Effect.fail(
          new StateStoreError({
            message: `Failed to read ${what}: its secrets are encrypted with '${header.by}', but this state store encrypts with '${encryption.id}'`,
          }),
        )
      : unwrapped.get(
          `${scopeKey(scope)}\u0000${header.key}`,
          encryption.unwrap(header.key, scope),
        );

  /** `encoded` with every secret sealed, and the header to store with it. */
  const seal = Effect.fn(function* (scope: SealingScope, encoded: unknown) {
    const key = yield* dataKey(scope);
    const body = yield* Effect.sync(() =>
      mapEnvelopes(encoded, REDACTED_MARKER, (secret) => ({
        [SEALED_MARKER]: sealSecret(key.plaintext, JSON.stringify(secret)),
      })),
    );
    return { header: { by: encryption.id, key: key.wrapped } satisfies SealedHeader, body };
  });

  /** A sealed body with every secret opened into `{ __redacted__ }`. */
  const openBody = Effect.fn(function* (
    scope: SealingScope,
    header: SealedHeader,
    body: unknown,
    what: string,
  ) {
    const key = yield* unwrap(header, scope, what);
    return yield* Effect.try({
      try: () =>
        mapEnvelopes(body, SEALED_MARKER, (sealed) => ({
          [REDACTED_MARKER]: JSON.parse(openSecret(key, sealed)),
        })),
      catch: (cause) => parseError(what, cause),
    });
  });

  /** A sealed text record as plain JSON, every secret opened. */
  const openText = Effect.fn(function* (scope: SealingScope, text: string, what: string) {
    const parts = splitSealed(text);
    if (parts === undefined) return yield* parseError(what, new Error("malformed sealed record"));
    const body = yield* Effect.try({
      try: () => JSON.parse(parts.body) as unknown,
      catch: (cause) => parseError(what, cause),
    });
    return JSON.stringify(yield* openBody(scope, parts, body, what));
  });

  return {
    encode: Effect.fn(function* (scope, value, space) {
      const encoded = yield* Effect.sync(() => encodeState(value));
      if (!holdsSecret(encoded)) return JSON.stringify(encoded, null, space);
      const { header, body } = yield* seal(scope, encoded);
      return `${SEALED_PREFIX}${header.by}:${header.key}\n${JSON.stringify(body, null, space)}`;
    }),
    decode: <T>(scope: SealingScope, text: string, what: string) =>
      isSealed(text)
        ? openText(scope, text, what).pipe(
            // Revive the opened JSON exactly as a plain record revives.
            Effect.flatMap((opened) => parsePlain<T>(opened, what)),
          )
        : parsePlain<T>(text, what),
    encodeJson: Effect.fn(function* (scope, value) {
      const encoded = yield* Effect.sync(() => encodeState(value));
      if (!holdsSecret(encoded)) return encoded;
      const { header, body } = yield* seal(scope, encoded);
      // A record keeps its top-level fields, so a store can still read its
      // status; any other value is carried in the header.
      return isRecord(body)
        ? { ...body, [SEALED_RECORD_MARKER]: header }
        : { [SEALED_RECORD_MARKER]: { ...header, value: body } };
    }),
    decodeJson: <T>(scope: SealingScope, json: unknown, what: string) => {
      const sealed = splitSealedJson(json);
      return sealed === undefined
        ? Effect.sync(() => reviveStateRecursive(json) as T)
        : openBody(scope, sealed, sealed.body, what).pipe(
            Effect.map((opened) => reviveStateRecursive(opened) as T),
          );
    },
    open: (scope, text) =>
      isSealed(text) ? openText(scope, text, "sealed state") : Effect.succeed(text),
    unsealed,
  };
};

/**
 * The codec for the {@link StateEncryption} in context: sealing when one is
 * provided, {@link plainCodec} otherwise. Stores resolve it when they are
 * built.
 */
export const stateCodec: Effect.Effect<StateCodec> = Effect.serviceOption(StateEncryption).pipe(
  Effect.map((encryption) =>
    Option.isSome(encryption) ? makeSealingCodec(encryption.value) : plainCodec,
  ),
);
