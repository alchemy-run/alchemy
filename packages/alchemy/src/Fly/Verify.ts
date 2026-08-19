import type { SecretkeyVerifyError } from "@distilled.cloud/fly-io/machines";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { SecretKey } from "./SecretKey.ts";

export interface VerifyRequest {
  /** Original payload. */
  plaintext: Uint8Array | ArrayLike<number>;
  /** Signature produced by {@link Sign}. */
  signature: Uint8Array | ArrayLike<number>;
}

export interface VerifyResult {
  /** Fly returns 200 only when the signature is valid. */
  valid: true;
}

/**
 * Verify a signature with a Fly {@link SecretKey}. The App and key name
 * are fixed by `Verify(key)`. A bad signature is a typed error from the
 * Machines API. Provide {@link VerifyHttp} on the Action / Service Effect.
 *
 * @binding
 *
 * @section Signing
 * @example Verify a signature
 * ```typescript
 * const verify = yield* Fly.Verify(key);
 * const { valid } = yield* verify({ plaintext, signature });
 * ```
 */
export interface Verify extends Binding.Service<
  Verify,
  "Fly.Verify",
  (
    key: SecretKey,
  ) => Effect.Effect<
    (
      request: VerifyRequest,
    ) => Effect.Effect<VerifyResult, SecretkeyVerifyError, RuntimeContext>
  >
> {}

export const Verify = Binding.Service<Verify>("Fly.Verify");
