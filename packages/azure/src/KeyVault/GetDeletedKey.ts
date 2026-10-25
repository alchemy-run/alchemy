import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationClient } from "./KeyTypes.ts";

/**
 * Read a soft-deleted Key Vault key: its attributes, deletion date, and purge
 * date.
 *
 * Binding assigns a custom role with only `Microsoft.KeyVault/vaults/keys/read`
 * (one role definition per stack, shared by every host) on the key.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link GetDeletedKeyHttp}.
 *
 * ### Reading Deleted Keys
 * **Example:** Read the deleted key
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("app-key", { vault: vault.vaultName });
 *     const getDeletedKey = yield* Azure.KeyVault.GetDeletedKey(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const deleted = yield* getDeletedKey();
 *         return yield* HttpServerResponse.json({ purgeAt: deleted.scheduledPurgeDate });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.GetDeletedKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface GetDeletedKey extends Binding.Service<
  GetDeletedKey,
  "Azure.KeyVault.GetDeletedKey",
  (
    key: Key,
  ) => Effect.Effect<
    KeyOperationClient<keys.GetDeletedKeyRequest, keys.DeletedKeyBundle, keys.GetDeletedKeyError>
  >
> {}

export const GetDeletedKey = Binding.Service<GetDeletedKey>("Azure.KeyVault.GetDeletedKey");
