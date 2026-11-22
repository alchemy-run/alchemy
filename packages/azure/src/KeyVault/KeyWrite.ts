import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationRequest } from "./KeyTypes.ts";

/** Write client for one Key Vault key. */
export interface WriteKeyClient {
  /** Create a new version with fresh key material (`kty` is required). */
  create(
    request: KeyOperationRequest<keys.CreateKeyRequest>,
  ): Effect.Effect<keys.KeyBundle, keys.CreateKeyError, RuntimeContext>;
  /** Import external key material (a JSON web key) as a new version. */
  import(
    request: KeyOperationRequest<keys.ImportKeyRequest>,
  ): Effect.Effect<keys.KeyBundle, keys.ImportKeyError, RuntimeContext>;
  /** Change attributes, permitted operations, or tags of a version (the latest by default). */
  update(
    request: KeyOperationRequest<keys.UpdateKeyRequest>,
  ): Effect.Effect<keys.KeyBundle, keys.UpdateKeyError, RuntimeContext>;
  /** Create a new version now, with the parameters of the current one. */
  rotate(): Effect.Effect<keys.KeyBundle, keys.RotateKeyError, RuntimeContext>;
  /** Replace the automatic rotation policy. */
  setRotationPolicy(
    request: KeyOperationRequest<keys.UpdateKeyRotationPolicyRequest>,
  ): Effect.Effect<keys.KeyRotationPolicy, keys.UpdateKeyRotationPolicyError, RuntimeContext>;
  /** Delete the key (every version); soft-deleted keys stay recoverable. */
  delete(): Effect.Effect<keys.DeletedKeyBundle, keys.DeleteKeyError, RuntimeContext>;
}

/**
 * Manage an Azure Key Vault key's versions, attributes, and rotation policy
 * from any host.
 *
 * Built on {@link CreateKey}, {@link ImportKey}, {@link UpdateKey},
 * {@link RotateKey}, {@link UpdateKeyRotationPolicy}, and
 * {@link DeleteKey}: binding assigns one custom role per operation on the
 * key only, with exactly `keys/create/action`, `keys/import/action`,
 * `keys/update/action`, `keys/rotate/action`,
 * `keyrotationpolicies/write`, and `keys/delete` (one role definition each
 * per stack, shared by every host). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default). On a host with a managed
 * identity the roles go to that identity; on any other host Alchemy
 * creates an Entra service principal for it (see `AzureBindings`).
 * Provide {@link KeyWriteHttp}.
 *
 * ### Managing Keys
 * **Example:** Rotate a key on demand
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("cmk", { vault: vault.vaultName });
 *     const cmk = yield* Azure.KeyVault.KeyWrite(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const bundle = yield* cmk.rotate();
 *         return yield* HttpServerResponse.json({ kid: bundle.key?.kid });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.KeyWriteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface KeyWrite extends Binding.Service<
  KeyWrite,
  "Azure.KeyVault.KeyWrite",
  (key: Key) => Effect.Effect<WriteKeyClient>
> {}

export const KeyWrite = Binding.Service<KeyWrite>("Azure.KeyVault.KeyWrite");
