import type * as kms from "@distilled.cloud/stackit/kms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";

export interface GetKeyRequest extends Omit<
  kms.GetKeyRequest,
  "projectId" | "regionId" | "keyRingId" | "keyId"
> {}

/**
 * Runtime binding for KMS `getKey`: read a key's algorithm, purpose, state and
 * deletion date.
 *
 * Bind this operation to a {@link Key} in a Function/Worker init phase and
 * provide {@link GetKeyHttp}. The key's identifiers are injected into each
 * request. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.get` permission on the project holding the key, the
 * narrowest scope STACKIT binds. That one permission also allows encrypt, decrypt,
 * sign, verify and every read, on every key in the project: splitting them into
 * bindings narrows what this code can call, not what its credential could do.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Reading the Key
 * **Example:** Report a key's state from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ring = Stackit.KMS.KeyRing("Ring", {});
 * export const DataKey = Ring.pipe(
 *   Effect.flatMap((ring) =>
 *     Stackit.KMS.Key("DataKey", {
 *       keyRingId: ring.keyRingId,
 *       algorithm: "aes_256_gcm",
 *       purpose: "symmetric_encrypt_decrypt",
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const call = yield* Stackit.KMS.GetKey(yield* DataKey);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const key = yield* call();
 *         return yield* HttpServerResponse.json({ state: key.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.GetKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface GetKey extends Binding.Service<
  GetKey,
  "Stackit.KMS.GetKey",
  (
    key: Key,
  ) => Effect.Effect<
    (request?: GetKeyRequest) => Effect.Effect<kms.Key, kms.GetKeyError, RuntimeContext>
  >
> {}

export const GetKey = Binding.Service<GetKey>("Stackit.KMS.GetKey");
