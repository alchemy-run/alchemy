import type * as kms from "@distilled.cloud/stackit/kms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { KeyVersionSelector, NoActiveKeyVersion, SecretBytes } from "./CryptoTypes.ts";
import type { Key } from "./Key.ts";

export interface VerifyRequest {
  /** The data that was signed. */
  data: SecretBytes;
  /** The signature to check. */
  signature: Uint8Array;
  /**
   * The key version that signed, as `Sign` reported. `"latest"` only works until
   * the key is rotated.
   */
  version: KeyVersionSelector;
}

export interface VerifyResult {
  /** Whether the signature is valid. */
  valid: boolean;
  /** The version that checked it. */
  version: number;
}

export type VerifyError = kms.VerifyError | kms.ListVersionsError | NoActiveKeyVersion;

/** Verify a signature with the bound key. */
export type VerifyClient = (
  request: VerifyRequest,
) => Effect.Effect<VerifyResult, VerifyError, RuntimeContext>;

/**
 * Runtime binding for KMS `verify`: check a signature or MAC from
 * `Stackit.KMS.Sign` against a {@link Key}.
 *
 * Bind it to a key in a Function/Worker init phase and provide {@link VerifyHttp}.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.get` permission on the project holding the key, the
 * narrowest scope STACKIT binds. That one permission also allows encrypt, decrypt,
 * sign, verify and every read, on every key in the project: splitting them into
 * bindings narrows what this code can call, not what its credential could do.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Verifying Signatures
 * **Example:** Check a signature from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ring = Stackit.KMS.KeyRing("Ring", {});
 * export const SigningKey = Ring.pipe(
 *   Effect.flatMap((ring) =>
 *     Stackit.KMS.Key("SigningKey", {
 *       keyRingId: ring.keyRingId,
 *       algorithm: "ecdsa_p256_sha256",
 *       purpose: "asymmetric_sign_verify",
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const verify = yield* Stackit.KMS.Verify(yield* SigningKey);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { valid } = yield* verify({
 *           data: new TextEncoder().encode("release-1.2.3"),
 *           signature: new Uint8Array([]),
 *           version: 1,
 *         });
 *         return yield* HttpServerResponse.json({ valid });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.VerifyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface Verify extends Binding.Service<
  Verify,
  "Stackit.KMS.Verify",
  (key: Key) => Effect.Effect<VerifyClient>
> {}

export const Verify = Binding.Service<Verify>("Stackit.KMS.Verify");
