import type * as kms from "@distilled.cloud/stackit/kms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DestroyVersionRequest } from "./DestroyVersion.ts";
import type { DisableVersionRequest } from "./DisableVersion.ts";
import type { EnableVersionRequest } from "./EnableVersion.ts";
import type { ImportKeyClient } from "./ImportKey.ts";
import type { Key } from "./Key.ts";
import type { RestoreVersionRequest } from "./RestoreVersion.ts";
import type { RotateKeyRequest } from "./RotateKey.ts";

/** The operations that change a bound key. The key's identifiers are injected. */
export interface WriteKeyClient {
  /** Create a new version of the key. */
  rotateKey(
    request?: RotateKeyRequest,
  ): Effect.Effect<kms.Version, kms.RotateKeyError, RuntimeContext>;
  /** Enable a disabled version again. */
  enableVersion(
    request: EnableVersionRequest,
  ): Effect.Effect<kms.EnableVersionResponse, kms.EnableVersionError, RuntimeContext>;
  /** Disable a version. */
  disableVersion(
    request: DisableVersionRequest,
  ): Effect.Effect<kms.DisableVersionResponse, kms.DisableVersionError, RuntimeContext>;
  /** Remove a version's key material. Everything encrypted with it becomes unreadable. */
  destroyVersion(
    request: DestroyVersionRequest,
  ): Effect.Effect<kms.DestroyVersionResponse, kms.DestroyVersionError, RuntimeContext>;
  /** Undo `destroyVersion`. */
  restoreVersion(
    request: RestoreVersionRequest,
  ): Effect.Effect<kms.RestoreVersionResponse, kms.RestoreVersionError, RuntimeContext>;
  /** Import wrapped key material as a new version. */
  importKey: ImportKeyClient;
}

/**
 * Rotate a {@link Key} and manage its versions from a Function/Worker, including
 * `destroyVersion`, which ends the key material of a version.
 *
 * Bind it in the init phase and provide {@link WriteKeyHttp}. A foreign host signs
 * with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.update` permission on the project holding the key,
 * the narrowest scope STACKIT binds. That one permission allows every key and
 * version change, on every key in the project, including `DestroyVersion`.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Managing a Key
 * **Example:** Rotate a key and disable its old version, from a Cloudflare Worker
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
 *     const writeKey = yield* Stackit.KMS.WriteKey(yield* DataKey);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const version = yield* writeKey.rotateKey();
 *         yield* writeKey.disableVersion({ versionNumber: version.number - 1 });
 *         return yield* HttpServerResponse.json({ version: version.number });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.WriteKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface WriteKey extends Binding.Service<
  WriteKey,
  "Stackit.KMS.WriteKey",
  (key: Key) => Effect.Effect<WriteKeyClient>
> {}

export const WriteKey = Binding.Service<WriteKey>("Stackit.KMS.WriteKey");
