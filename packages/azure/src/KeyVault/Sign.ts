import type * as keys from "@distilled.cloud/azure/keyvault-keys";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { KeyOperationClient } from "./KeyTypes.ts";

/**
 * Sign a digest with a Key Vault key. `value` is the base64url digest (SHA-256
 * for `RS256`/`PS256`/`ES256`); the result is the base64url signature.
 *
 * Binding assigns a custom role with only
 * `Microsoft.KeyVault/vaults/keys/sign/action` (one role definition per stack,
 * shared by every host) on the key.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity. On any other host (a Cloudflare Worker, an
 * AWS Lambda) Alchemy creates an Entra service principal for the host,
 * assigns the role to it, and binds its client secret into the host's env
 * (see `AzureBindings`). The vault must use Azure RBAC
 * (`enableRbacAuthorization`, the default).
 * Provide {@link SignHttp}.
 *
 * ### Signing
 * **Example:** Sign a SHA-256 digest
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("app-key", { vault: vault.vaultName });
 *     const sign = yield* Azure.KeyVault.Sign(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const digest = createHash("sha256").update(payload).digest("base64url");
 *         const signed = yield* sign({ alg: "RS256", value: digest });
 *         return yield* HttpServerResponse.json({ kid: signed.kid, signature: signed.value });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.SignHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface Sign extends Binding.Service<
  Sign,
  "Azure.KeyVault.Sign",
  (
    key: Key,
  ) => Effect.Effect<KeyOperationClient<keys.SignRequest, keys.KeyOperationResult, keys.SignError>>
> {}

export const Sign = Binding.Service<Sign>("Azure.KeyVault.Sign");
