import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Instance } from "./Instance.ts";
import type { ReadSecretClient } from "./ReadSecret.ts";
import type { WriteSecretClient } from "./WriteSecret.ts";

/** Every operation on a bound instance's secrets. */
export interface ReadWriteSecretClient extends ReadSecretClient, WriteSecretClient {}

/**
 * Read and write secrets in an {@link Instance} from a Function/Worker.
 *
 * Bind it in the init phase and provide {@link ReadWriteSecretHttp}. The binding logs in to
 * Vault and caches its token. A failed login fails the call with `ConfigError`.
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
 * ### Reading and Writing Secrets
 * **Example:** Rewrite a secret only if nothing else changed it
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
 *     const secrets = yield* Stackit.SecretsManager.ReadWriteSecret(yield* Vault);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const secret = yield* secrets.get({ secretPath: "payments/counter" });
 *         const written = yield* secrets.put({
 *           secretPath: "payments/counter",
 *           data: secret.data.data,
 *           options: { cas: secret.data.metadata.version },
 *         });
 *         return yield* HttpServerResponse.json({ version: written.data.version });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.SecretsManager.ReadWriteSecretHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category SecretsManager
 */
export interface ReadWriteSecret extends Binding.Service<
  ReadWriteSecret,
  "Stackit.SecretsManager.ReadWriteSecret",
  (instance: Instance) => Effect.Effect<ReadWriteSecretClient>
> {}

export const ReadWriteSecret = Binding.Service<ReadWriteSecret>(
  "Stackit.SecretsManager.ReadWriteSecret",
);
