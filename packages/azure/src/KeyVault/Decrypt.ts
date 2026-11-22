import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationClient } from "./KeyTypes.ts";

/**
 * Decrypt one block of data with a Key Vault key (the reverse of {@link
 * Encrypt}). Pass the `keyVersion` that encrypted it; `value` and the result
 * are base64url.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/decrypt/action` (one role definition per
 * stack, shared by every host) on the key.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link DecryptHttp}.
 *
 * ### Decrypting Data
 * **Example:** Decrypt with RSA-OAEP-256
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("app-key", { vault: vault.vaultName });
 *     const decrypt = yield* Azure.KeyVault.Decrypt(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* decrypt({ keyVersion, alg: "RSA-OAEP-256", value: ciphertext });
 *         return HttpServerResponse.text(Buffer.from(result.value ?? "", "base64url").toString());
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.DecryptHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface Decrypt extends Binding.Service<
  Decrypt,
  "Azure.KeyVault.Decrypt",
  (
    key: Key,
  ) => Effect.Effect<
    KeyOperationClient<keys.DecryptRequest, keys.KeyOperationResult, keys.DecryptError>
  >
> {}

export const Decrypt = Binding.Service<Decrypt>("Azure.KeyVault.Decrypt");
