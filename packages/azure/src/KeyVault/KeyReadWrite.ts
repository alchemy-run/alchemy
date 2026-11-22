import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Key } from "./Key.ts";
import type { ReadKeyClient } from "./KeyRead.ts";
import type { WriteKeyClient } from "./KeyWrite.ts";

/** Read + write client for one Key Vault key. */
export interface ReadWriteKeyClient extends ReadKeyClient, WriteKeyClient {}

/**
 * Read and manage an Azure Key Vault key from any host: everything
 * {@link KeyRead} and {@link KeyWrite} do.
 *
 * Binding assigns the roles of both on the key only (custom roles with
 * exactly `keys/read`, `keyrotationpolicies/read`, `keys/create/action`,
 * `keys/import/action`, `keys/update/action`, `keys/rotate/action`,
 * `keyrotationpolicies/write`, and `keys/delete`). The vault must use
 * Azure RBAC (`enableRbacAuthorization`, the default). On a host with a
 * managed identity the roles go to that identity; on any other host
 * Alchemy creates an Entra service principal for it (see `AzureBindings`).
 * Provide {@link KeyReadWriteHttp}.
 *
 * ### Reading and Managing Keys
 * **Example:** Create a new version and read it back
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const vault = yield* Azure.KeyVault.Vault("keys");
 *     const key = yield* Azure.KeyVault.Key("cmk", { vault: vault.vaultName });
 *     const cmk = yield* Azure.KeyVault.KeyReadWrite(key);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* cmk.create({ kty: "RSA", key_size: 3072 });
 *         const latest = yield* cmk.get();
 *         return yield* HttpServerResponse.json({ kid: latest.key?.kid });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.KeyVault.KeyReadWriteHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category KeyVault
 */
export interface KeyReadWrite extends Binding.Service<
  KeyReadWrite,
  "Azure.KeyVault.KeyReadWrite",
  (key: Key) => Effect.Effect<ReadWriteKeyClient>
> {}

export const KeyReadWrite = Binding.Service<KeyReadWrite>("Azure.KeyVault.KeyReadWrite");
