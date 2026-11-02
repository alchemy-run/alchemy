import type * as kms from "@distilled.cloud/stackit/kms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { WrappingKey } from "./WrappingKey.ts";

export interface GetWrappingKeyRequest extends Omit<
  kms.GetWrappingKeyRequest,
  "projectId" | "regionId" | "keyRingId" | "wrappingKeyId"
> {}

/**
 * Runtime binding for KMS `getWrappingKey`: read a wrapping key's public key
 * and expiry, to wrap material for `Stackit.KMS.ImportKey`.
 *
 * Bind this operation to a {@link WrappingKey} in a Function/Worker init phase and
 * provide {@link GetWrappingKeyHttp}. The wrapping key's identifiers are injected into each
 * request. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.get` permission on the project holding the wrapping key, the
 * narrowest scope STACKIT binds. That one permission also allows encrypt, decrypt,
 * sign, verify and every read, on every key in the project: splitting them into
 * bindings narrows what this code can call, not what its credential could do.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Reading the Wrapping Key
 * **Example:** Serve a wrapping key's public key from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ring = Stackit.KMS.KeyRing("Ring", {});
 * export const Wrapper = Ring.pipe(
 *   Effect.flatMap((ring) =>
 *     Stackit.KMS.WrappingKey("Wrapper", {
 *       keyRingId: ring.keyRingId,
 *       algorithm: "rsa_2048_oaep_sha256",
 *       purpose: "wrap_symmetric_key",
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const call = yield* Stackit.KMS.GetWrappingKey(yield* Wrapper);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const wrappingKey = yield* call();
 *         return yield* HttpServerResponse.json({
 *           publicKey: wrappingKey.publicKey,
 *           expiresAt: wrappingKey.expiresAt,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.GetWrappingKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface GetWrappingKey extends Binding.Service<
  GetWrappingKey,
  "Stackit.KMS.GetWrappingKey",
  (
    wrappingKey: WrappingKey,
  ) => Effect.Effect<
    (
      request?: GetWrappingKeyRequest,
    ) => Effect.Effect<kms.WrappingKey, kms.GetWrappingKeyError, RuntimeContext>
  >
> {}

export const GetWrappingKey = Binding.Service<GetWrappingKey>("Stackit.KMS.GetWrappingKey");
