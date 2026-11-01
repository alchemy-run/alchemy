import type * as kms from "@distilled.cloud/stackit/kms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { InvalidKmsPayload, KeyVersionSelector, NoActiveKeyVersion } from "./CryptoTypes.ts";
import type { Key } from "./Key.ts";

export interface DecryptRequest {
  /** The encrypted data. */
  ciphertext: Uint8Array;
  /**
   * The key version that encrypted it, as `Encrypt` reported. `"latest"` only
   * works until the key is rotated.
   */
  version: KeyVersionSelector;
}

export interface DecryptResult {
  /** The decrypted data. It stays `Redacted`: unwrap it only where you use it. */
  plaintext: Redacted.Redacted<Uint8Array>;
  /** The version that decrypted it. */
  version: number;
}

export type DecryptError =
  | kms.DecryptError
  | kms.ListVersionsError
  | NoActiveKeyVersion
  | InvalidKmsPayload;

/** Decrypt bytes with the bound key. */
export type DecryptClient = (
  request: DecryptRequest,
) => Effect.Effect<DecryptResult, DecryptError, RuntimeContext>;

/**
 * Runtime binding for KMS `decrypt`: decrypt bytes with a symmetric or asymmetric
 * encryption {@link Key}. The plaintext comes back `Redacted`, so it can't reach
 * a log or a trace by accident.
 *
 * Bind it to a key in a Function/Worker init phase and provide {@link DecryptHttp}.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.get` permission on the project holding the key, the
 * narrowest scope STACKIT binds. That one permission also allows encrypt, decrypt,
 * sign, verify and every read, on every key in the project: splitting them into
 * bindings narrows what this code can call, not what its credential could do.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Decrypting Data
 * **Example:** Decrypt stored data from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Redacted from "effect/Redacted";
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
 *     const decrypt = yield* Stackit.KMS.Decrypt(yield* DataKey);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const ciphertext = new Uint8Array([]);
 *         const { plaintext } = yield* decrypt({ ciphertext, version: 1 });
 *         return HttpServerResponse.text(
 *           new TextDecoder().decode(Redacted.value(plaintext)),
 *         );
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.DecryptHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface Decrypt extends Binding.Service<
  Decrypt,
  "Stackit.KMS.Decrypt",
  (key: Key) => Effect.Effect<DecryptClient>
> {}

export const Decrypt = Binding.Service<Decrypt>("Stackit.KMS.Decrypt");
