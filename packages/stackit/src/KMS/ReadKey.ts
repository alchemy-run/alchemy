import type * as kms from "@distilled.cloud/stackit/kms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GetKeyRequest } from "./GetKey.ts";
import type { GetVersionRequest } from "./GetVersion.ts";
import type { Key } from "./Key.ts";
import type { ListVersionsRequest } from "./ListVersions.ts";

/** The read operations on a bound key. The key's identifiers are injected. */
export interface ReadKeyClient {
  /** Read the key's algorithm, purpose, state and deletion date. */
  getKey(request?: GetKeyRequest): Effect.Effect<kms.Key, kms.GetKeyError, RuntimeContext>;
  /** Read one version, with its public key on an asymmetric key. */
  getVersion(
    request: GetVersionRequest,
  ): Effect.Effect<kms.Version, kms.GetVersionError, RuntimeContext>;
  /** List every version of the key. */
  listVersions(
    request?: ListVersionsRequest,
  ): Effect.Effect<kms.VersionList, kms.ListVersionsError, RuntimeContext>;
}

/**
 * Read a {@link Key} and its versions from a Function/Worker. It includes no
 * crypto operation; bind `Stackit.KMS.Encrypt` and friends for those.
 *
 * Bind it in the init phase and provide {@link ReadKeyHttp}. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.get` permission on the project holding the key, the
 * narrowest scope STACKIT binds. That one permission also allows encrypt, decrypt,
 * sign, verify and every read, on every key in the project: splitting them into
 * bindings narrows what this code can call, not what its credential could do.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Reading a Key
 * **Example:** Report a key's versions from a Cloudflare Worker
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
 *     const readKey = yield* Stackit.KMS.ReadKey(yield* DataKey);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* readKey.getKey();
 *         const { versions } = yield* readKey.listVersions();
 *         return yield* HttpServerResponse.json({
 *           state: live.state,
 *           versions: versions.length,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.ReadKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface ReadKey extends Binding.Service<
  ReadKey,
  "Stackit.KMS.ReadKey",
  (key: Key) => Effect.Effect<ReadKeyClient>
> {}

export const ReadKey = Binding.Service<ReadKey>("Stackit.KMS.ReadKey");
