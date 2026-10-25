import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationClient } from "./KeyTypes.ts";

/**
 * Wrap (encrypt) a symmetric key with a Key Vault key, e.g. a data-encryption
 * key for envelope encryption. `value` and the result are base64url.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/wrap/action` (one role definition per stack,
 * shared by every host) on the key.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link WrapKeyHttp}.
 *
 * ### Wrapping Keys
 * **Example:** Wrap a data-encryption key
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("app-key", { vault: vault.vaultName });
 *     const wrapKey = yield* Azure.KeyVault.WrapKey(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const wrapped = yield* wrapKey({ alg: "RSA-OAEP-256", value: dek.toString("base64url") });
 *         return yield* HttpServerResponse.json({ kid: wrapped.kid, wrapped: wrapped.value });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.WrapKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface WrapKey extends Binding.Service<
  WrapKey,
  "Azure.KeyVault.WrapKey",
  (
    key: Key,
  ) => Effect.Effect<
    KeyOperationClient<keys.WrapKeyRequest, keys.KeyOperationResult, keys.WrapKeyError>
  >
> {}

export const WrapKey = Binding.Service<WrapKey>("Azure.KeyVault.WrapKey");
