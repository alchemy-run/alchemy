import type * as kv from "@distilled.cloud/stackit/secrets_manager_kv";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";

export interface GetSecretRequest extends Omit<kv.GetSecretRequest, "mount"> {}

/**
 * Runtime binding for Vault KV v2 `getSecret`: read a version of a secret, the
 * latest by default. String values come back `Redacted`.
 *
 * Bind this operation to an {@link Instance} in a Function/Worker init phase and
 * provide {@link GetSecretHttp}. The instance's URL and mount are injected into each
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
 * ### Reading a Secret
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
 *     const getSecret = yield* Stackit.SecretsManager.GetSecret(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const secret = yield* getSecret({ secretPath: "payments/api" });
 *         return yield* HttpServerResponse.json({ version: secret.data.metadata.version });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.GetSecretHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface GetSecret extends Binding.Service<
  GetSecret,
  "Stackit.SecretsManager.GetSecret",
  (
    instance: Instance,
  ) => Effect.Effect<
    (
      request: GetSecretRequest,
    ) => Effect.Effect<kv.GetSecretResponse, kv.GetSecretError, RuntimeContext>
  >
> {}

export const GetSecret = Binding.Service<GetSecret>("Stackit.SecretsManager.GetSecret");
