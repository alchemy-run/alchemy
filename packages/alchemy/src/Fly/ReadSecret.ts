import type {
  AppSecret,
  AppSecrets,
  SecretGetError,
  SecretsListError,
} from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Secret } from "./Secret.ts";

/**
 * Binding that lets runtime code read Fly.io App secrets.
 *
 * Authenticates with a deploy token minted via `appCreateDeployToken` when
 * the host is a {@link Machine} or {@link Service}, and with the ambient
 * `FLY_API_TOKEN` inside an Action. The App is fixed by
 * `ReadSecret(secret)` so calls take no `app_name`. Provide
 * {@link ReadSecretHttp} on the Action / Service Effect.
 *
 * @binding
 * @product Machines
 * @category Secrets
 *
 * @section Reading secrets at runtime
 * @example Get and list secrets from an Action
 * Bind the client in the Action's Init phase and provide {@link ReadSecretHttp}.
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Fly from "alchemy/Fly";
 * import * as Effect from "effect/Effect";
 * import * as Redacted from "effect/Redacted";
 *
 * const Check = Alchemy.Action(
 *   "Check",
 *   Effect.gen(function* () {
 *     const secrets = yield* Fly.ReadSecret(dbUrl);
 *     return Effect.fn(function* () {
 *       const listed = yield* secrets.list();
 *       const got = yield* secrets.get();
 *       return { listed, got };
 *     });
 *   }).pipe(Effect.provide(Fly.ReadSecretHttp)),
 * );
 * ```
 */
export interface ReadSecret extends Binding.Service<
  ReadSecret,
  "Fly.ReadSecret",
  (secret: Secret) => Effect.Effect<ReadSecretClient>
> {}

export const ReadSecret = Binding.Service<ReadSecret>("Fly.ReadSecret");

/**
 * Read-only App secret operations. The App is fixed when the client is
 * bound, so no `app_name` is passed per call. `get` defaults to the bound
 * Secret's name.
 */
export interface ReadSecretClient {
  /**
   * Fetch one secret. Defaults to the bound Secret's name. Plaintext
   * (`value`) is only returned from inside a Machine in the same App.
   */
  get(name?: string): Effect.Effect<AppSecret, SecretGetError, RuntimeContext>;
  /**
   * List secrets on the bound Secret's App. Plaintext is only returned
   * from inside a Machine in the same App.
   */
  list(): Effect.Effect<AppSecrets, SecretsListError, RuntimeContext>;
}
