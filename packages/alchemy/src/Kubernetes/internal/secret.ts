import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * A key was supplied in both `stringData` and `binaryData`. Kubernetes
 * resolves this silently (`stringData` wins), which hides mistakes; alchemy
 * refuses instead.
 */
export class SecretDataKeyConflict extends Data.TaggedError(
  "Kubernetes.SecretDataKeyConflict",
)<{
  keys: string[];
}> {
  override get message(): string {
    return `Kubernetes.Secret keys must be unique across stringData and binaryData; duplicated: ${this.keys.join(", ")}`;
  }
}

export interface SecretData {
  stringData?: Record<string, Redacted.Redacted<string>>;
  binaryData?: Record<string, Redacted.Redacted<string>>;
}

/**
 * Merge `stringData` (UTF-8, base64-encoded here) and `binaryData` (already
 * base64) into the wire-level `data` map. Values are unwrapped only at this
 * edge, immediately before the Kubernetes API request.
 */
export const encodeSecretData = ({
  stringData = {},
  binaryData = {},
}: SecretData): Effect.Effect<Record<string, string>, SecretDataKeyConflict> =>
  Effect.gen(function* () {
    const conflicts = Object.keys(stringData).filter((key) =>
      Object.hasOwn(binaryData, key),
    );
    if (conflicts.length > 0) {
      return yield* new SecretDataKeyConflict({ keys: conflicts });
    }
    return yield* Effect.sync(() => ({
      ...Object.fromEntries(
        Object.entries(stringData).map(([key, value]) => [
          key,
          Buffer.from(Redacted.value(value), "utf8").toString("base64"),
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(binaryData).map(([key, value]) => [
          key,
          Redacted.value(value),
        ]),
      ),
    }));
  });
