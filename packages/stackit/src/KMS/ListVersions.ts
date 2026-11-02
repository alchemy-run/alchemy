import type * as kms from "@distilled.cloud/stackit/kms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";

export interface ListVersionsRequest extends Omit<
  kms.ListVersionsRequest,
  "projectId" | "regionId" | "keyRingId" | "keyId"
> {}

/**
 * Runtime binding for KMS `listVersions`: list every version of a key.
 *
 * Bind this operation to a {@link Key} in a Function/Worker init phase and
 * provide {@link ListVersionsHttp}. The key's identifiers are injected into each
 * request. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.get` permission on the project holding the key, the
 * narrowest scope STACKIT binds. That one permission also allows encrypt, decrypt,
 * sign, verify and every read, on every key in the project: splitting them into
 * bindings narrows what this code can call, not what its credential could do.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Listing Versions
 * **Example:** List a key's versions from a Cloudflare Worker
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
 *     const call = yield* Stackit.KMS.ListVersions(yield* DataKey);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { versions } = yield* call();
 *         return yield* HttpServerResponse.json({
 *           versions: versions.map((version) => version.number),
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.ListVersionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface ListVersions extends Binding.Service<
  ListVersions,
  "Stackit.KMS.ListVersions",
  (
    key: Key,
  ) => Effect.Effect<
    (
      request?: ListVersionsRequest,
    ) => Effect.Effect<kms.VersionList, kms.ListVersionsError, RuntimeContext>
  >
> {}

export const ListVersions = Binding.Service<ListVersions>("Stackit.KMS.ListVersions");
