import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationClient } from "./KeyTypes.ts";

/**
 * Encrypt one block of data with a Key Vault key. `value` and the result are
 * base64url; RSA keys take `RSA-OAEP-256` (or `RSA-OAEP`, `RSA1_5`).
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/encrypt/action` (one role definition per
 * stack, shared by every host) on the key.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link EncryptHttp}.
 *
 * ### Encrypting Data
 * **Example:** Encrypt with RSA-OAEP-256
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("app-key", { vault: vault.vaultName });
 *     const encrypt = yield* Azure.KeyVault.Encrypt(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* encrypt({ alg: "RSA-OAEP-256", value: Buffer.from("hello").toString("base64url") });
 *         return yield* HttpServerResponse.json({ kid: result.kid, ciphertext: result.value });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.EncryptHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface Encrypt extends Binding.Service<
  Encrypt,
  "Azure.KeyVault.Encrypt",
  (
    key: Key,
  ) => Effect.Effect<
    KeyOperationClient<keys.EncryptRequest, keys.KeyOperationResult, keys.EncryptError>
  >
> {}

export const Encrypt = Binding.Service<Encrypt>("Azure.KeyVault.Encrypt");
