import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationClient } from "./KeyTypes.ts";

/**
 * Verify a signature over a digest with a Key Vault key. `digest` and `value`
 * (the signature) are base64url; the result's `value` is `true` when it
 * verifies.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/verify/action` (one role definition per
 * stack, shared by every host) on the key.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link VerifyHttp}.
 *
 * ### Verifying Signatures
 * **Example:** Verify an RS256 signature
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("app-key", { vault: vault.vaultName });
 *     const verify = yield* Azure.KeyVault.Verify(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* verify({ keyVersion, alg: "RS256", digest, value: signature });
 *         return yield* HttpServerResponse.json({ valid: result.value === true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.VerifyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface Verify extends Binding.Service<
  Verify,
  "Azure.KeyVault.Verify",
  (
    key: Key,
  ) => Effect.Effect<KeyOperationClient<keys.VerifyRequest, keys.KeyVerifyResult, keys.VerifyError>>
> {}

export const Verify = Binding.Service<Verify>("Azure.KeyVault.Verify");
