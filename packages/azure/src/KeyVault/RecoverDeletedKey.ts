import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationClient } from "./KeyTypes.ts";

/**
 * Recover a soft-deleted Key Vault key to its latest version.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/recover/action` (one role definition per
 * stack, shared by every host) on the key.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link RecoverDeletedKeyHttp}.
 *
 * ### Recovering Keys
 * **Example:** Recover a deleted key
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("app-key", { vault: vault.vaultName });
 *     const recoverDeletedKey = yield* Azure.KeyVault.RecoverDeletedKey(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const bundle = yield* recoverDeletedKey();
 *         return yield* HttpServerResponse.json({ kid: bundle.key?.kid });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.RecoverDeletedKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface RecoverDeletedKey extends Binding.Service<
  RecoverDeletedKey,
  "Azure.KeyVault.RecoverDeletedKey",
  (
    key: Key,
  ) => Effect.Effect<
    KeyOperationClient<keys.RecoverDeletedKeyRequest, keys.KeyBundle, keys.RecoverDeletedKeyError>
  >
> {}

export const RecoverDeletedKey = Binding.Service<RecoverDeletedKey>(
  "Azure.KeyVault.RecoverDeletedKey",
);
