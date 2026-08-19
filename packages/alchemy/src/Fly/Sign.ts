import type { SecretkeySignError } from "@distilled.cloud/fly-io/machines";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { SecretKey } from "./SecretKey.ts";

export interface SignRequest {
  /** Bytes to sign. */
  plaintext: Uint8Array | ArrayLike<number>;
}

export interface SignResult {
  signature: Uint8Array;
}

/**
 * Sign with a Fly {@link SecretKey} (`nacl_sign`, `hs256`, `es256`, …).
 * The private key never leaves Fly KMS. Provide {@link SignHttp} on the
 * Action / Service Effect.
 *
 * @binding
 *
 * @section Signing
 * @example Sign a payload
 * ```typescript
 * const sign = yield* Fly.Sign(key);
 * const { signature } = yield* sign({
 *   plaintext: new TextEncoder().encode("release-manifest-v1"),
 * });
 * ```
 */
export interface Sign extends Binding.Service<
  Sign,
  "Fly.Sign",
  (
    key: SecretKey,
  ) => Effect.Effect<
    (
      request: SignRequest,
    ) => Effect.Effect<SignResult, SecretkeySignError, RuntimeContext>
  >
> {}

export const Sign = Binding.Service<Sign>("Fly.Sign");
