import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationClient } from "./KeyTypes.ts";

/**
 * Rotate a Key Vault key now: Key Vault creates a new version with the
 * parameters of the current one.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/rotate/action` (one role definition per
 * stack, shared by every host) on the key.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link RotateKeyHttp}.
 *
 * ### Rotating Keys
 * **Example:** Rotate on demand
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("app-key", { vault: vault.vaultName });
 *     const rotateKey = yield* Azure.KeyVault.RotateKey(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const bundle = yield* rotateKey();
 *         return yield* HttpServerResponse.json({ kid: bundle.key?.kid });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.RotateKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface RotateKey extends Binding.Service<
  RotateKey,
  "Azure.KeyVault.RotateKey",
  (
    key: Key,
  ) => Effect.Effect<KeyOperationClient<keys.RotateKeyRequest, keys.KeyBundle, keys.RotateKeyError>>
> {}

export const RotateKey = Binding.Service<RotateKey>("Azure.KeyVault.RotateKey");
