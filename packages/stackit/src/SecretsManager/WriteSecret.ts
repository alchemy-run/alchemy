import type * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { DeleteSecretRequest } from "./DeleteSecret.ts";
import type { DestroySecretVersionsRequest } from "./DestroySecretVersions.ts";
import type { Instance } from "./Instance.ts";
import type { PurgeSecretRequest } from "./PurgeSecret.ts";
import type { PutSecretRequest } from "./PutSecret.ts";
import type { PutSecretMetadataRequest } from "./PutSecretMetadata.ts";
import type { UndeleteSecretRequest } from "./UndeleteSecret.ts";

/** The write operations on a bound instance's secrets. Its URL and mount are injected. */
export interface WriteSecretClient {
  /** Write a new version of a secret. */
  put(
    request: PutSecretRequest,
  ): Effect.Effect<kv.PutSecretResponse, kv.PutSecretError, RuntimeContext>;
  /** Soft-delete versions of a secret, the latest by default. */
  delete(
    request: DeleteSecretRequest,
  ): Effect.Effect<
    kv.DeleteSecretVersionsResponse,
    kv.DeleteSecretVersionsError | kv.DeleteLatestSecretVersionError,
    RuntimeContext
  >;
  /** Restore soft-deleted versions of a secret. */
  undelete(
    request: UndeleteSecretRequest,
  ): Effect.Effect<
    kv.UndeleteSecretVersionsResponse,
    kv.UndeleteSecretVersionsError,
    RuntimeContext
  >;
  /** Permanently delete the data of versions of a secret. */
  destroyVersions(
    request: DestroySecretVersionsRequest,
  ): Effect.Effect<kv.DestroySecretVersionsResponse, kv.DestroySecretVersionsError, RuntimeContext>;
  /** Permanently delete a secret, all its versions and its metadata. */
  purge(
    request: PurgeSecretRequest,
  ): Effect.Effect<kv.DeleteSecretMetadataResponse, kv.DeleteSecretMetadataError, RuntimeContext>;
  /** Set a secret's version limit, check-and-set requirement or custom metadata. */
  putMetadata(
    request: PutSecretMetadataRequest,
  ): Effect.Effect<kv.PutSecretMetadataResponse, kv.PutSecretMetadataError, RuntimeContext>;
}

/**
 * Write secrets in an {@link Instance} from a Function/Worker.
 *
 * Bind it in the init phase and provide {@link WriteSecretHttp}. The binding logs in to
 * Vault and caches its token. A failed login fails the call with `ConfigError`.
 *
 * STACKIT has no write-only access, so this binding's AppRole can read as well.
 * The client only exposes writes; use {@link ReadWriteSecret} to read too.
 *
 * Access: an AppRole with write access, created per host and per instance, whose
 * role id and secret id reach the host's env as a `Redacted` value. **It reads
 * and writes every secret in the instance**: STACKIT has no write-only AppRole
 * and can't limit one to a path, so use one instance per trust boundary.
 *
 * **The host's egress address has to be in `Instance.acls`**, or Vault answers
 * `403 permission denied`. A host with no stable egress address, such as a
 * Cloudflare Worker, only fits a range as wide as `0.0.0.0/0`.
 *
 * ### Writing Secrets
 * **Example:** Write a secret from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Redacted from "effect/Redacted";
 *
 * export const Vault = Stackit.SecretsManager.Instance("Vault", {
 *   acls: ["0.0.0.0/0"],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const secrets = yield* Stackit.SecretsManager.WriteSecret(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const written = yield* secrets.put({
 *           secretPath: "payments/api",
 *           data: { apiKey: Redacted.make("not-a-real-key") },
 *         });
 *         return yield* HttpServerResponse.json({ version: written.data.version });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.WriteSecretHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface WriteSecret extends Binding.Service<
  WriteSecret,
  "Stackit.SecretsManager.WriteSecret",
  (instance: Instance) => Effect.Effect<WriteSecretClient>
> {}

export const WriteSecret = Binding.Service<WriteSecret>("Stackit.SecretsManager.WriteSecret");
