import type * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface PutSecretMetadataRequest extends Omit<kv.PutSecretMetadataRequest, "mount"> {}

/**
 * Runtime binding for Vault KV v2 `putSecretMetadata`: set a secret's version
 * limit, check-and-set requirement or custom metadata.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link PutSecretMetadataHttp}. The instance's URL and mount are injected into each
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
 * ### Setting Metadata
 * **Example:** Limit a secret's versions from a Cloudflare Worker
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
 *     const putMetadata = yield* Stackit.SecretsManager.PutSecretMetadata(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* putMetadata({ secretPath: "payments/api", max_versions: 5 });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.PutSecretMetadataHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface PutSecretMetadata extends Binding.Service<
  PutSecretMetadata,
  "Stackit.SecretsManager.PutSecretMetadata",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: PutSecretMetadataRequest,
    ) => Effect.Effect<kv.PutSecretMetadataResponse, kv.PutSecretMetadataError, RuntimeContext>
  >
> {}

export const PutSecretMetadata = Binding.Service<PutSecretMetadata>(
  "Stackit.SecretsManager.PutSecretMetadata",
);
