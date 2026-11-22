import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationClient } from "./KeyTypes.ts";

/**
 * Release an exportable Key Vault key to an attested environment (secure key
 * release). `target` is an attestation token (e.g. from Microsoft Azure
 * Attestation) that satisfies the key's release policy.
 *
 * Binding assigns **Key Vault Crypto Service Release User** (exactly
 * `Microsoft.KeyVault/vaults/keys/release/action`) on the key.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link ReleaseKeyHttp}.
 *
 * ### Releasing Keys
 * **Example:** Release a key to a confidential VM
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("app-key", { vault: vault.vaultName });
 *     const releaseKey = yield* Azure.KeyVault.ReleaseKey(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const released = yield* releaseKey({ keyVersion, target: attestationToken });
 *         return HttpServerResponse.text(released.value ?? "");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.ReleaseKeyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface ReleaseKey extends Binding.Service<
  ReleaseKey,
  "Azure.KeyVault.ReleaseKey",
  (
    key: Key,
  ) => Effect.Effect<
    KeyOperationClient<keys.ReleaseRequest, keys.KeyReleaseResult, keys.ReleaseError>
  >
> {}

export const ReleaseKey = Binding.Service<ReleaseKey>("Azure.KeyVault.ReleaseKey");
