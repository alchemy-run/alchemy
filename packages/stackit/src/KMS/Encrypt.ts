import type * as kms from "@distilled.cloud/stackit/kms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type {
  InvalidKmsPayload,
  KeyVersionSelector,
  NoActiveKeyVersion,
  SecretBytes,
} from "./CryptoTypes.ts";
import type { Key } from "./Key.ts";

export interface EncryptRequest {
  /** The data to encrypt. Pass it `Redacted` to keep it out of logs on your side too. */
  plaintext: SecretBytes;
  /**
   * The key version to encrypt with.
   * @default "latest"
   */
  version?: KeyVersionSelector;
}

export interface EncryptResult {
  /** The encrypted data. */
  ciphertext: Uint8Array;
  /** The version that encrypted it. Store it with the ciphertext: `Decrypt` asks for it. */
  version: number;
}

export type EncryptError =
  | kms.EncryptError
  | kms.ListVersionsError
  | NoActiveKeyVersion
  | InvalidKmsPayload;

/** Encrypt bytes with the bound key. */
export type EncryptClient = (
  request: EncryptRequest,
) => Effect.Effect<EncryptResult, EncryptError, RuntimeContext>;

/**
 * Runtime binding for KMS `encrypt`: encrypt bytes with a symmetric or asymmetric
 * encryption {@link Key}. It takes and returns raw bytes, and does the wire's
 * base64 itself.
 *
 * Bind it to a key in a Function/Worker init phase and provide {@link EncryptHttp}.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.get` permission on the project holding the key, the
 * narrowest scope STACKIT binds. That one permission also allows encrypt, decrypt,
 * sign, verify and every read, on every key in the project: splitting them into
 * bindings narrows what this code can call, not what its credential could do.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Encrypting Data
 * **Example:** Encrypt a value from a Cloudflare Worker
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
 *     const encrypt = yield* Stackit.KMS.Encrypt(yield* DataKey);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { ciphertext, version } = yield* encrypt({
 *           plaintext: Redacted.make(new TextEncoder().encode("hello")),
 *         });
 *         return yield* HttpServerResponse.json({
 *           ciphertext: Array.from(ciphertext),
 *           version,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.EncryptHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface Encrypt extends Binding.Service<
  Encrypt,
  "Stackit.KMS.Encrypt",
  (key: Key) => Effect.Effect<EncryptClient>
> {}

export const Encrypt = Binding.Service<Encrypt>("Stackit.KMS.Encrypt");
