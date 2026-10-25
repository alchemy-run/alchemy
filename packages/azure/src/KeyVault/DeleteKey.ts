import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationClient } from "./KeyTypes.ts";

/**
 * Delete a Key Vault key (every version). With soft delete (the default) the
 * key stays recoverable until `scheduledPurgeDate`; see {@link
 * RecoverDeletedKey} and {@link PurgeDeletedKey}.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/delete` (one role definition per stack,
 * shared by every host) on the key.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link DeleteKeyHttp}.
 *
 * ### Deleting Keys
 * **Example:** Delete a key
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("app-key", { vault: vault.vaultName });
 *     const deleteKey = yield* Azure.KeyVault.DeleteKey(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const deleted = yield* deleteKey();
 *         return yield* HttpServerResponse.json({ recoveryId: deleted.recoveryId });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.DeleteKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface DeleteKey extends Binding.Service<
  DeleteKey,
  "Azure.KeyVault.DeleteKey",
  (
    key: Key,
  ) => Effect.Effect<
    KeyOperationClient<keys.DeleteKeyRequest, keys.DeletedKeyBundle, keys.DeleteKeyError>
  >
> {}

export const DeleteKey = Binding.Service<DeleteKey>("Azure.KeyVault.DeleteKey");
