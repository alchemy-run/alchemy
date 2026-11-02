import type * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetSecretMetadataRequest extends Omit<kv.GetSecretMetadataRequest, "mount"> {}

/**
 * Runtime binding for Vault KV v2 `getSecretMetadata`: read a secret's current
 * version and version history, without its values.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetSecretMetadataHttp}. The instance's URL and mount are injected into each
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
 * ### Reading Metadata
 * **Example:** Read a secret's current version from a Cloudflare Worker
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
 *     const getMetadata = yield* Stackit.SecretsManager.GetSecretMetadata(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { data } = yield* getMetadata({ secretPath: "payments/api" });
 *         return yield* HttpServerResponse.json({ version: data.current_version });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.GetSecretMetadataHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface GetSecretMetadata extends Binding.Service<
  GetSecretMetadata,
  "Stackit.SecretsManager.GetSecretMetadata",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetSecretMetadataRequest,
    ) => Effect.Effect<kv.GetSecretMetadataResponse, kv.GetSecretMetadataError, RuntimeContext>
  >
> {}

export const GetSecretMetadata = Binding.Service<GetSecretMetadata>(
  "Stackit.SecretsManager.GetSecretMetadata",
);
