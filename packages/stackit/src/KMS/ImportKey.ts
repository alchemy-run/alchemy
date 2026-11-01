import type * as kms from "@distilled.cloud/stackit/kms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SecretBytes } from "./CryptoTypes.ts";
import type { Key } from "./Key.ts";

export interface ImportKeyRequest {
  /** Your key material, wrapped with the public key of `wrappingKeyId`. */
  wrappedKey: SecretBytes;
  /** The `Stackit.KMS.WrappingKey` it was wrapped with. */
  wrappingKeyId: string;
}

/** Import wrapped key material as a new version of the bound key. */
export type ImportKeyClient = (
  request: ImportKeyRequest,
) => Effect.Effect<kms.Version, kms.ImportKeyError, RuntimeContext>;

/**
 * Runtime binding for KMS `importKey`: upload your own key material, wrapped with
 * a `Stackit.KMS.WrappingKey`, as a new version of an `importOnly` {@link Key}.
 * This is a runtime operation rather than a resource so the material never reaches
 * Alchemy's state.
 *
 * Bind it to a key in a Function/Worker init phase and provide {@link ImportKeyHttp}.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.update` permission on the project holding the key,
 * the narrowest scope STACKIT binds. That one permission allows every key and
 * version change, on every key in the project, including `DestroyVersion`.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Importing Key Material
 * **Example:** Import material a caller wrapped, from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { HttpServerRequest } from "effect/http/HttpServerRequest";
 * import * as Redacted from "effect/Redacted";
 *
 * export const Ring = Stackit.KMS.KeyRing("Ring", {});
 * export const Imported = Ring.pipe(
 *   Effect.flatMap((ring) =>
 *     Stackit.KMS.Key("Imported", {
 *       keyRingId: ring.keyRingId,
 *       algorithm: "aes_256_gcm",
 *       purpose: "symmetric_encrypt_decrypt",
 *       importOnly: true,
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const importKey = yield* Stackit.KMS.ImportKey(yield* Imported);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const url = new URL(request.url, "http://worker");
 *         const body = yield* request.arrayBuffer;
 *         const version = yield* importKey({
 *           wrappedKey: Redacted.make(new Uint8Array(body)),
 *           wrappingKeyId: url.searchParams.get("wrappingKeyId") ?? "",
 *         });
 *         return yield* HttpServerResponse.json({ version: version.number });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.ImportKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface ImportKey extends Binding.Service<
  ImportKey,
  "Stackit.KMS.ImportKey",
  (key: Key) => Effect.Effect<ImportKeyClient>
> {}

export const ImportKey = Binding.Service<ImportKey>("Stackit.KMS.ImportKey");
