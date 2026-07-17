import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { sha256 } from "./sha256.ts";

/**
 * Stable, collision-free structural signature used by local dev providers to
 * decide whether a running instance needs to be torn down and restarted.
 *
 * A canonical JSON serialization (sorted keys, unwrapped `Redacted`,
 * cycle-safe) gives an exact comparison instead of a lossy fingerprint
 * (`Hash.structure` XOR-folds sibling fields, so mirrored values — e.g. an
 * env var that also appears in derived bindings — can cancel out). The
 * serialization is SHA-256 hashed so each retained signature is a fixed
 * 64-char digest rather than a copy of the whole props/bindings blob.
 */
export const structuralSignature = (value: unknown): Effect.Effect<string> => {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (typeof input === "bigint") return `bigint:${input.toString()}`;
    if (input === null || typeof input !== "object") return input;
    if (Redacted.isRedacted(input)) {
      return { __redacted: normalize(Redacted.value(input)) };
    }
    if (seen.has(input)) return "[circular]";
    seen.add(input);
    if (input instanceof Uint8Array) return { __bytes: Array.from(input) };
    if (Array.isArray(input)) return input.map(normalize);
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [
          key,
          normalize((input as Record<string, unknown>)[key]),
        ]),
    );
  };
  return sha256(JSON.stringify(normalize(value)));
};
