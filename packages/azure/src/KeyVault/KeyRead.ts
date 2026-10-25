import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";

/** Read client for one Key Vault key. */
export interface ReadKeyClient {
  /** Read the latest (or a specific) version: attributes and public key. */
  get(version?: string): Effect.Effect<keys.KeyBundle, keys.GetKeyError, RuntimeContext>;
  /** One page of the key's versions; pass the previous page's `nextLink` for the next. */
  versions(options?: {
    maxresults?: number;
    nextLink?: string;
  }): Effect.Effect<keys.KeyListResult, keys.GetKeyVersionsError, RuntimeContext>;
  /** The key's automatic rotation policy. */
  rotationPolicy(): Effect.Effect<
    keys.KeyRotationPolicy,
    keys.GetKeyRotationPolicyError,
    RuntimeContext
  >;
}

/**
 * Read an Azure Key Vault key (attributes, public key, versions, rotation
 * policy) from any host.
 *
 * Built on {@link GetKey}, {@link GetKeyVersions}, and
 * {@link GetKeyRotationPolicy}: binding assigns two custom roles on the key
 * only, one with `Microsoft.KeyVault/vaults/keys/read` and one with
 * `Microsoft.KeyVault/vaults/keyrotationpolicies/read` (one role definition
 * each per stack, shared by every host). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default). On a host with a managed
 * identity the roles go to that identity; on any other host Alchemy
 * creates an Entra service principal for it (see `AzureBindings`).
 * Provide {@link KeyReadHttp}.
 *
 * ### Reading Keys
 * **Example:** Publish the public key
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("signing", { vault: vault.vaultName });
 *     const signing = yield* Azure.KeyVault.KeyRead(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const bundle = yield* signing.get();
 *         return yield* HttpServerResponse.json({ keys: [bundle.key] });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.KeyReadHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface KeyRead extends Binding.Service<
  KeyRead,
  "Azure.KeyVault.KeyRead",
  (key: Key) => Effect.Effect<ReadKeyClient>
> {}

export const KeyRead = Binding.Service<KeyRead>("Azure.KeyVault.KeyRead");
