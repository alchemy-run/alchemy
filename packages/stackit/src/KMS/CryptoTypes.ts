import * as Data from "effect/Data";
import type * as Redacted from "effect/Redacted";

/** Secret bytes: plain, or `Redacted` so they can't reach a log by accident. */
export type SecretBytes = Uint8Array | Redacted.Redacted<Uint8Array>;

/**
 * The key version a call uses: a version number, or `"latest"` for the newest
 * active one. `"latest"` looks the version up with one extra API call.
 */
export type KeyVersionSelector = number | "latest";

/**
 * `version: "latest"` on a key with no active version: an import-only key before
 * its first import, or a key whose versions are all disabled or destroyed.
 */
export class NoActiveKeyVersion extends Data.TaggedError("Stackit.KMS.NoActiveKeyVersion")<{
  readonly keyId: string;
  readonly message: string;
}> {}

/**
 * STACKIT returned a payload that isn't valid base64. The message never includes
 * the payload.
 */
export class InvalidKmsPayload extends Data.TaggedError("Stackit.KMS.InvalidPayload")<{
  readonly operation: string;
  readonly message: string;
}> {}
