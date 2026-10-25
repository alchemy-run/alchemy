import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationClient } from "./KeyTypes.ts";

/**
 * Unwrap a symmetric key that {@link WrapKey} wrapped. Pass the `keyVersion`
 * that wrapped it; `value` and the result are base64url.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/unwrap/action` (one role definition per
 * stack, shared by every host) on the key.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link UnwrapKeyHttp}.
 *
 * ### Unwrapping Keys
 * **Example:** Unwrap a data-encryption key
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("app-key", { vault: vault.vaultName });
 *     const unwrapKey = yield* Azure.KeyVault.UnwrapKey(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const dek = yield* unwrapKey({ keyVersion, alg: "RSA-OAEP-256", value: wrapped });
 *         return HttpServerResponse.text(dek.value ?? "");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.UnwrapKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface UnwrapKey extends Binding.Service<
  UnwrapKey,
  "Azure.KeyVault.UnwrapKey",
  (
    key: Key,
  ) => Effect.Effect<
    KeyOperationClient<keys.UnwrapKeyRequest, keys.KeyOperationResult, keys.UnwrapKeyError>
  >
> {}

export const UnwrapKey = Binding.Service<UnwrapKey>("Azure.KeyVault.UnwrapKey");
