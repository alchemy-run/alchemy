import type * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GetSecretRequest } from "./GetSecret.ts";
import type { GetSecretMetadataRequest } from "./GetSecretMetadata.ts";
import type { Instance } from "./Instance.ts";
import type { ListSecretsRequest } from "./ListSecrets.ts";

/** The read operations on a bound instance's secrets. Its URL and mount are injected. */
export interface ReadSecretClient {
  /** Read a version of a secret, the latest by default. String values come back `Redacted`. */
  get(
    request: GetSecretRequest,
  ): Effect.Effect<kv.GetSecretResponse, kv.GetSecretError, RuntimeContext>;
  /** List the keys under a folder, or at the root. Keys ending in `/` are folders. */
  list(
    request?: ListSecretsRequest,
  ): Effect.Effect<kv.ListSecretsResponse, kv.ListSecretsError, RuntimeContext>;
  /** Read a secret's current version and version history, without its values. */
  getMetadata(
    request: GetSecretMetadataRequest,
  ): Effect.Effect<kv.GetSecretMetadataResponse, kv.GetSecretMetadataError, RuntimeContext>;
}

/**
 * Read secrets in an {@link Instance} from a Function/Worker.
 *
 * Bind it in the init phase and provide {@link ReadSecretHttp}. The binding logs in to
 * Vault and caches its token. A failed login fails the call with `ConfigError`.
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
 * ### Reading Secrets
 * **Example:** Read a secret from a Cloudflare Worker
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
 *     const secrets = yield* Stackit.SecretsManager.ReadSecret(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const secret = yield* secrets.get({ secretPath: "payments/api" });
 *         const { data } = yield* secrets.list({});
 *         return yield* HttpServerResponse.json({
 *           version: secret.data.metadata.version,
 *           keys: data.keys,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.ReadSecretHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface ReadSecret extends Binding.Service<
  ReadSecret,
  "Stackit.SecretsManager.ReadSecret",
  (instance: Instance) => Effect.Effect<ReadSecretClient>
> {}

export const ReadSecret = Binding.Service<ReadSecret>("Stackit.SecretsManager.ReadSecret");
