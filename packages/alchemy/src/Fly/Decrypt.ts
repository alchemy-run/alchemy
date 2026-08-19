import type { SecretkeyDecryptError } from "@distilled.cloud/fly-io/machines";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { SecretKey } from "./SecretKey.ts";

export interface DecryptRequest {
  /** Ciphertext produced by {@link Encrypt}. */
  ciphertext: Uint8Array | ArrayLike<number>;
  /** Optional AEAD associated data. Must match encryption. */
  associatedData?: Uint8Array | ArrayLike<number>;
}

export interface DecryptResult {
  /** Plaintext, wrapped so it never logs. Unwrap with `Redacted.value`. */
  plaintext: Redacted.Redacted<Uint8Array>;
}

/**
 * Decrypt with a Fly {@link SecretKey}. The App and key name are fixed by
 * `Decrypt(key)`; calls take no `app_name`. Provide {@link DecryptHttp} on
 * the Action / Service Effect.
 *
 * @binding
 *
 * @section Decrypting
 * @example Decrypt a payload
 * ```typescript
 * import * as Redacted from "effect/Redacted";
 *
 * const decrypt = yield* Fly.Decrypt(key);
 * const { plaintext } = yield* decrypt({ ciphertext });
 * const bytes = Redacted.value(plaintext);
 * ```
 */
export interface Decrypt extends Binding.Service<
  Decrypt,
  "Fly.Decrypt",
  (
    key: SecretKey,
  ) => Effect.Effect<
    (
      request: DecryptRequest,
    ) => Effect.Effect<DecryptResult, SecretkeyDecryptError, RuntimeContext>
  >
> {}

export const Decrypt = Binding.Service<Decrypt>("Fly.Decrypt");
