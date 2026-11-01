import type * as kms from "@distilled.cloud/stackit/kms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";

export interface GetVersionRequest extends Omit<
  kms.GetVersionRequest,
  "projectId" | "regionId" | "keyRingId" | "keyId"
> {}

/**
 * Runtime binding for KMS `getVersion`: read one version of a key: its state
 * and, on an asymmetric key, its public key.
 *
 * Bind this operation to a {@link Key} in a Function/Worker init phase and
 * provide {@link GetVersionHttp}. The key's identifiers are injected into each
 * request. A foreign host signs with a service account key Alchemy creates for it.
 *
 * Access: the `kms.keyring.get` permission on the project holding the key, the
 * narrowest scope STACKIT binds. That one permission also allows encrypt, decrypt,
 * sign, verify and every read, on every key in the project: splitting them into
 * bindings narrows what this code can call, not what its credential could do.
 * The permission name comes from the KMS spec. Alchemy grants it through a
 * custom role, one per project, so the deployer needs `iam.role.add`.
 *
 * ### Reading a Version
 * **Example:** Serve a signing key's public key from a Cloudflare Worker
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
 *     const call = yield* Stackit.KMS.GetVersion(yield* SigningKey);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const version = yield* call({ versionNumber: 1 });
 *         return yield* HttpServerResponse.json({ publicKey: version.publicKey });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.KMS.GetVersionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KMS
 */
export interface GetVersion extends Binding.Service<
  GetVersion,
  "Stackit.KMS.GetVersion",
  (
    key: Key,
  ) => Effect.Effect<
    (request: GetVersionRequest) => Effect.Effect<kms.Version, kms.GetVersionError, RuntimeContext>
  >
> {}

export const GetVersion = Binding.Service<GetVersion>("Stackit.KMS.GetVersion");
