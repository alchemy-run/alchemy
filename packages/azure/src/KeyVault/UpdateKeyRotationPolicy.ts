import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationClient } from "./KeyTypes.ts";

/**
 * Replace the automatic rotation policy of a Key Vault key. `expiryTime` must
 * be at least 28 days (`P28D`).
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keyrotationpolicies/write` (one role definition
 * per stack, shared by every host) on the key.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link UpdateKeyRotationPolicyHttp}.
 *
 * ### Updating Rotation Policies
 * **Example:** Rotate every 90 days
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("app-key", { vault: vault.vaultName });
 *     const updateKeyRotationPolicy = yield* Azure.KeyVault.UpdateKeyRotationPolicy(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* updateKeyRotationPolicy({
 *           attributes: { expiryTime: "P1Y" },
 *           lifetimeActions: [{ action: { type: "Rotate" }, trigger: { timeAfterCreate: "P90D" } }],
 *         });
 *         return HttpServerResponse.text("updated");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.UpdateKeyRotationPolicyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface UpdateKeyRotationPolicy extends Binding.Service<
  UpdateKeyRotationPolicy,
  "Azure.KeyVault.UpdateKeyRotationPolicy",
  (
    key: Key,
  ) => Effect.Effect<
    KeyOperationClient<
      keys.UpdateKeyRotationPolicyRequest,
      keys.KeyRotationPolicy,
      keys.UpdateKeyRotationPolicyError
    >
  >
> {}

export const UpdateKeyRotationPolicy = Binding.Service<UpdateKeyRotationPolicy>(
  "Azure.KeyVault.UpdateKeyRotationPolicy",
);
