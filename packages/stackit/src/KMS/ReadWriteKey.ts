import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { ReadKeyClient } from "./ReadKey.ts";
import type { WriteKeyClient } from "./WriteKey.ts";

/** Every read and write operation on a bound key. */
export interface ReadWriteKeyClient extends ReadKeyClient, WriteKeyClient {}

/**
 * Read and manage a {@link Key} and its versions from a Function/Worker.
 *
 * Bind it in the init phase and provide {@link ReadWriteKeyHttp}. A foreign host
 * signs with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.get` and `kms.keyring.update` permissions on the project
 * holding the key, the narrowest scope STACKIT binds. Together they allow every
 * crypto operation, read and change on every key in the project.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Reading and Managing a Key
 * **Example:** Rotate a key and report its versions, from a Cloudflare Worker
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
 *     const readWriteKey = yield* Stackit.KMS.ReadWriteKey(yield* DataKey);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* readWriteKey.rotateKey();
 *         const { versions } = yield* readWriteKey.listVersions();
 *         return yield* HttpServerResponse.json({ versions: versions.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.ReadWriteKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface ReadWriteKey extends Binding.Service<
  ReadWriteKey,
  "Stackit.KMS.ReadWriteKey",
  (key: Key) => Effect.Effect<ReadWriteKeyClient>
> {}

export const ReadWriteKey = Binding.Service<ReadWriteKey>("Stackit.KMS.ReadWriteKey");
