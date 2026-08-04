import * as Duration from "effect/Duration";
import * as Redacted from "effect/Redacted";
import { isResource } from "../Resource.ts";
// Type-only: SecretCodec.ts pulls in node:crypto, which must not be
// bundled into workerd consumers of this module (Cloudflare StateStore DO).
import type { SecretCodec } from "./SecretCodec.ts";

/**
 * JSON marker used to tag a `Redacted<T>` value when writing state.
 * The reviver recognises objects with exactly this key and rebuilds
 * the `Redacted` wrapper on read.
 */
export const REDACTED_MARKER = "__redacted__";

/**
 * JSON marker used to tag an *encrypted* `Redacted<T>` value when a
 * {@link SecretCodec} is active (i.e. `ALCHEMY_PASSWORD` is set). The
 * payload is the codec's ciphertext of the JSON-encoded inner value, so
 * secrets never reach the state store in the clear.
 */
export const SECRET_MARKER = "__secret__";

/**
 * JSON marker used to tag a `Duration` value when writing state.
 * The reviver recognises objects with exactly this key and rebuilds
 * a real `Duration` instance on read so that downstream code can call
 * `Duration.toSeconds`, `Duration.toMillis`, etc. without first
 * decoding `Duration.toJSON`'s `{_id,_tag,...}` shape.
 */
export const DURATION_MARKER = "__duration__";

const decodeDuration = (encoded: unknown): Duration.Duration | undefined => {
  if (encoded === null || typeof encoded !== "object") return undefined;
  const json = encoded as {
    _tag?: "Millis" | "Nanos" | "Infinity" | "NegativeInfinity";
    millis?: number;
    nanos?: string;
  };
  switch (json._tag) {
    case "Millis":
      return json.millis !== undefined
        ? Duration.millis(json.millis)
        : undefined;
    case "Nanos":
      return json.nanos !== undefined
        ? Duration.nanos(BigInt(json.nanos))
        : undefined;
    case "Infinity":
      return Duration.infinity;
    case "NegativeInfinity":
      return Duration.zero; // Effect treats negatives as zero clamp
    default:
      return undefined;
  }
};

/**
 * Recursively encode a state value for JSON serialisation.
 *
 * - `Redacted<T>` values are wrapped as `{ [REDACTED_MARKER]: <inner> }`
 *   so the actual string is persisted rather than the `<redacted>`
 *   placeholder produced by the default `toJSON` — unless a `codec` is
 *   provided, in which case they are wrapped as
 *   `{ [SECRET_MARKER]: <ciphertext> }` and never persisted in plaintext.
 * - `Resource` instances are flattened to `{ id, type, props, attr }`
 *   so persisted state matches the schema used by the loader.
 * - Plain objects and arrays are walked structurally.
 */
export const encodeState = (value: unknown, codec?: SecretCodec): unknown => {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  if (Redacted.isRedacted(value)) {
    // The inner value is encoded WITHOUT the codec: the whole envelope is
    // encrypted, so nested markers inside it stay plain.
    return codec
      ? {
          [SECRET_MARKER]: codec.encrypt(
            JSON.stringify(encodeState(Redacted.value(value))),
          ),
        }
      : {
          [REDACTED_MARKER]: encodeState(Redacted.value(value)),
        };
  }
  if (Duration.isDuration(value)) {
    // `JSON.stringify(Duration.seconds(N))` already invokes Duration.toJSON,
    // but encodeState is also called for code paths that don't go through
    // `JSON.stringify` (e.g. the HTTP state-store). Tag with our marker so
    // the reviver can unambiguously rebuild a real Duration instance —
    // Duration.toJSON's `{_id,_tag,...}` shape is NOT a valid Duration.Input.
    return {
      [DURATION_MARKER]: value.toJSON(),
    };
  }
  if (isResource(value)) {
    return {
      id: value.LogicalId,
      type: value.Type,
      props: encodeState(value.Props, codec),
      attr: encodeState(value.Attributes, codec),
    };
  }
  if (Array.isArray(value)) return value.map((v) => encodeState(v, codec));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = encodeState(v, codec);
    }
    return result;
  }
  return value;
};

/**
 * Whether a state value contains any `Redacted<T>` — i.e. whether
 * {@link encodeState} would need a {@link SecretCodec} at all. Lets
 * stores with expensive codec resolution (S3/KMS) skip it entirely for
 * secret-free values.
 */
export const containsRedacted = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return false;
  if (Redacted.isRedacted(value)) return true;
  if (Duration.isDuration(value)) return false;
  if (isResource(value)) {
    return containsRedacted(value.Props) || containsRedacted(value.Attributes);
  }
  if (Array.isArray(value)) return value.some(containsRedacted);
  return Object.values(value).some(containsRedacted);
};

/**
 * Cheap pre-parse check for encrypted envelopes in raw state JSON. A
 * plain string value containing the marker text can false-positive —
 * harmless, the reviver only decrypts actual single-key envelope
 * objects — but a real `{ "__secret__": ... }` key always matches, so
 * a `false` result guarantees the codec is not needed.
 */
export const hasSecretMarker = (json: string): boolean =>
  json.includes(`"${SECRET_MARKER}"`);

/**
 * Rebuild a `Redacted<T>` from a `{ [SECRET_MARKER]: <ciphertext> }`
 * envelope. Throws with an actionable message when no codec is available
 * (state was encrypted but `ALCHEMY_PASSWORD` is not set) — the state
 * stores surface this as a `StateStoreError`.
 */
const decodeSecret = (
  payload: unknown,
  codec: SecretCodec | undefined,
): Redacted.Redacted<unknown> => {
  if (typeof payload !== "string") {
    throw new Error(
      `Malformed "${SECRET_MARKER}" envelope in state: expected a string ciphertext.`,
    );
  }
  if (codec === undefined) {
    throw new Error(
      `State contains encrypted secrets ("${SECRET_MARKER}") but no decryption key is available. Set ALCHEMY_PASSWORD to the key that wrote this state.`,
    );
  }
  return Redacted.make(
    reviveStateRecursive(JSON.parse(codec.decrypt(payload))),
  );
};

/**
 * Build a JSON reviver that rebuilds `Redacted<T>` values that were
 * written through {@link encodeState}. Intended for use with `JSON.parse`.
 * Pass the ambient {@link SecretCodec} (if any) so `{ __secret__: ... }`
 * envelopes written under `ALCHEMY_PASSWORD` decrypt on read.
 */
export const makeStateReviver =
  (codec?: SecretCodec) =>
  (_key: string, value: unknown): unknown => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (REDACTED_MARKER in obj) {
        return Redacted.make(obj[REDACTED_MARKER]);
      }
      if (SECRET_MARKER in obj) {
        return decodeSecret(obj[SECRET_MARKER], codec);
      }
      if (DURATION_MARKER in obj) {
        const decoded = decodeDuration(obj[DURATION_MARKER]);
        if (decoded !== undefined) return decoded;
      }
    }
    return value;
  };

/**
 * JSON reviver without a secret codec — plaintext `__redacted__` markers
 * revive; encrypted `__secret__` envelopes throw (missing password).
 */
export const reviveState = makeStateReviver();

/**
 * Recursively walk an already-decoded value and rebuild `Redacted<T>`
 * instances from `{ [REDACTED_MARKER]: <inner> }` envelopes. Mirror
 * image of {@link encodeState} for callers that hold a parsed JS
 * value rather than a JSON string (e.g. the HTTP state-store client,
 * which receives values pre-parsed by `HttpApiClient`).
 */
export const reviveStateRecursive = (
  value: unknown,
  codec?: SecretCodec,
): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((v) => reviveStateRecursive(v, codec));
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === REDACTED_MARKER) {
    return Redacted.make(reviveStateRecursive(obj[REDACTED_MARKER]));
  }
  if (keys.length === 1 && keys[0] === SECRET_MARKER) {
    return decodeSecret(obj[SECRET_MARKER], codec);
  }
  if (keys.length === 1 && keys[0] === DURATION_MARKER) {
    const decoded = decodeDuration(obj[DURATION_MARKER]);
    if (decoded !== undefined) return decoded;
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = reviveStateRecursive(v, codec);
  }
  return result;
};
