import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationClient } from "./KeyTypes.ts";

/**
 * Back up every version of a Key Vault key as a protected blob that only Key
 * Vault can restore (with {@link RestoreKey}), in the same geography.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/backup/action` (one role definition per
 * stack, shared by every host) on the key.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link BackupKeyHttp}.
 *
 * ### Backing Up Keys
 * **Example:** Back up a key
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("app-key", { vault: vault.vaultName });
 *     const backupKey = yield* Azure.KeyVault.BackupKey(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const backup = yield* backupKey();
 *         return HttpServerResponse.text(backup.value ?? "");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.BackupKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface BackupKey extends Binding.Service<
  BackupKey,
  "Azure.KeyVault.BackupKey",
  (
    key: Key,
  ) => Effect.Effect<
    KeyOperationClient<keys.BackupKeyRequest, keys.BackupKeyResult, keys.BackupKeyError>
  >
> {}

export const BackupKey = Binding.Service<BackupKey>("Azure.KeyVault.BackupKey");
