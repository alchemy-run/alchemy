import type * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface DeleteSecretRequest {
  /** Location of the secret. */
  secretPath: string;
  /** The versions to delete. Omit it for the latest. */
  versions?: number[];
}

/**
 * Runtime binding for Vault KV v2: soft-delete versions of a secret, the latest
 * by default. Their data stays until destroyed, and `UndeleteSecret` restores
 * them.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link DeleteSecretHttp}. The instance's URL and mount are injected into each
 * request, and the binding logs in to Vault and caches its token. A failed login
 * fails the call with `ConfigError`.
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
 * ### Deleting a Secret
 * **Example:** Soft-delete a secret's latest version from a Cloudflare Worker
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
 *     const deleteSecret = yield* Stackit.SecretsManager.DeleteSecret(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteSecret({ secretPath: "payments/api" });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.DeleteSecretHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface DeleteSecret extends Binding.Service<
  DeleteSecret,
  "Stackit.SecretsManager.DeleteSecret",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: DeleteSecretRequest,
    ) => Effect.Effect<
      kv.DeleteSecretVersionsResponse,
      kv.DeleteSecretVersionsError | kv.DeleteLatestSecretVersionError,
      RuntimeContext
    >
  >
> {}

export const DeleteSecret = Binding.Service<DeleteSecret>("Stackit.SecretsManager.DeleteSecret");
