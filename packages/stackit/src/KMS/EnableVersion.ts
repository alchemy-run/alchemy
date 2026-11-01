import type * as kms from "@distilled.cloud/stackit/kms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";

export interface EnableVersionRequest extends Omit<
  kms.EnableVersionRequest,
  "projectId" | "regionId" | "keyRingId" | "keyId"
> {}

/**
 * Runtime binding for KMS `enableVersion`: enable a disabled version of a key
 * again.
 *
 * Bind this operation to a {@link Key} in a Function/Worker init phase and
 * provide {@link EnableVersionHttp}. The key's identifiers are injected into each
 * request. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.update` permission on the project holding the key,
 * the narrowest scope STACKIT binds. That one permission allows every key and
 * version change, on every key in the project, including `DestroyVersion`.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Enabling a Version
 * **Example:** Enable a version from a Cloudflare Worker
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
 *     const call = yield* Stackit.KMS.EnableVersion(yield* DataKey);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* call({ versionNumber: 1 });
 *         return HttpServerResponse.text("enabled");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.EnableVersionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface EnableVersion extends Binding.Service<
  EnableVersion,
  "Stackit.KMS.EnableVersion",
  (
    key: Key,
  ) => Effect.Effect<
    (
      request: EnableVersionRequest,
    ) => Effect.Effect<kms.EnableVersionResponse, kms.EnableVersionError, RuntimeContext>
  >
> {}

export const EnableVersion = Binding.Service<EnableVersion>("Stackit.KMS.EnableVersion");
