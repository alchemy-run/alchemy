import type * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface ListSecretsRequest {
  /** The folder to list. Omit it for the root of the instance. */
  secretPath?: string;
}

/**
 * Runtime binding for Vault KV v2: list the keys under a folder, or at the root
 * of the instance. Keys ending in `/` are folders.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link ListSecretsHttp}. The instance's URL and mount are injected into each
 * request, and the binding logs in to Vault and caches its token. A failed login
 * fails the call with `ConfigError`.
 *
 * Access: a read-only AppRole, created per host and per instance, whose role id
 * and secret id reach the host's env as a `Redacted` value. **It reads every
 * secret in the instance**: STACKIT can't limit an AppRole to a path, so use one
 * instance per trust boundary.
 *
 * **The host's egress address has to be in `Instance.acls`**, or Vault answers
 * `403 permission denied`. A host with no stable egress address, such as a
 * Cloudflare Worker, only fits a range as wide as `0.0.0.0/0`.
 *
 * ### Listing Secrets
 * **Example:** List the root keys from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Vault = Stackit.SecretsManager.Instance("Vault", {
 *   acls: ["0.0.0.0/0"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const listSecrets = yield* Stackit.SecretsManager.ListSecrets(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { data } = yield* listSecrets({});
 *         return yield* HttpServerResponse.json({ keys: data.keys });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.ListSecretsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface ListSecrets extends Binding.Service<
  ListSecrets,
  "Stackit.SecretsManager.ListSecrets",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: ListSecretsRequest,
    ) => Effect.Effect<kv.ListSecretsResponse, kv.ListSecretsError, RuntimeContext>
  >
> {}

export const ListSecrets = Binding.Service<ListSecrets>("Stackit.SecretsManager.ListSecrets");
