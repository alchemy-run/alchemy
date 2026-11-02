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

export interface SignRequest {
  /** The data to sign. */
  data: SecretBytes;
  /**
   * The key version to sign with.
   * @default "latest"
   */
  version?: KeyVersionSelector;
}

export interface SignResult {
  /** The signature (or MAC, on a `message_authentication_code` key). */
  signature: Uint8Array;
  /** The version that signed. `Verify` asks for it. */
  version: number;
}

export type SignError =
  | kms.SignError
  | kms.ListVersionsError
  | NoActiveKeyVersion
  | InvalidKmsPayload;

/** Sign bytes with the bound key. */
export type SignClient = (
  request: SignRequest,
) => Effect.Effect<SignResult, SignError, RuntimeContext>;

/**
 * Runtime binding for KMS `sign`: sign bytes with an `asymmetric_sign_verify`
 * {@link Key}, or compute a MAC with a `message_authentication_code` one.
 *
 * Bind it to a key in a Function/Worker init phase and provide {@link SignHttp}.
 * A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.get` permission on the project holding the key, the
 * narrowest scope STACKIT binds. That one permission also allows encrypt, decrypt,
 * sign, verify and every read, on every key in the project: splitting them into
 * bindings narrows what this code can call, not what its credential could do.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Signing Data
 * **Example:** Sign a message from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ring = Stackit.KMS.KeyRing("Ring", {});
 * export const SigningKey = Ring.pipe(
 *   Effect.flatMap((ring) =>
 *     Stackit.KMS.Key("SigningKey", {
 *       keyRingId: ring.keyRingId,
 *       algorithm: "ecdsa_p256_sha256",
 *       purpose: "asymmetric_sign_verify",
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const sign = yield* Stackit.KMS.Sign(yield* SigningKey);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { signature, version } = yield* sign({
 *           data: new TextEncoder().encode("release-1.2.3"),
 *         });
 *         return yield* HttpServerResponse.json({
 *           signature: Array.from(signature),
 *           version,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.SignHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface Sign extends Binding.Service<
  Sign,
  "Stackit.KMS.Sign",
  (key: Key) => Effect.Effect<SignClient>
> {}

export const Sign = Binding.Service<Sign>("Stackit.KMS.Sign");
