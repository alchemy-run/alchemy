import type {
  AppSecretsUpdateResp,
  DeleteAppSecretResponse,
  SecretCreateError,
  SecretDeleteError,
  SecretsUpdateError,
  SetAppSecretResponse,
} from "@distilled.cloud/fly-io/machines";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Secret } from "./Secret.ts";

/**
 * Binding that lets runtime code create, update, and delete Fly.io App
 * secrets.
 *
 * Authenticates with a deploy token minted via `appCreateDeployToken` when
 * the host is a {@link Machine} or {@link Service}, and with the ambient
 * `FLY_API_TOKEN` inside an Action. The App is fixed by
 * `WriteSecret(secret)` so calls take no `app_name`. Provide
 * {@link WriteSecretHttp} on the Action / Service Effect.
 *
 * @binding
 * @product Machines
 * @category Secrets
 *
 * @section Mutating secrets at runtime
 * @example Create, rotate, and delete from an Action
 * Bind the client in the Action's Init phase and provide {@link WriteSecretHttp}.
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Fly from "alchemy/Fly";
 * import * as Effect from "effect/Effect";
 * import * as Redacted from "effect/Redacted";
 *
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const secrets = yield* Fly.WriteSecret(dbUrl);
 *     return Effect.fn(function* () {
 *       yield* secrets.create("API_KEY", Redacted.make("sk_live"));
 *       yield* secrets.update("API_KEY", Redacted.make("sk_live_rotated"));
 *       yield* secrets.delete("API_KEY");
 *     });
 *   }).pipe(Effect.provide(Fly.WriteSecretHttp)),
 * );
 * ```
 */
export interface WriteSecret extends Binding.Service<
  WriteSecret,
  "Fly.WriteSecret",
  (secret: Secret) => Effect.Effect<WriteSecretClient>
> {}

export const WriteSecret = Binding.Service<WriteSecret>("Fly.WriteSecret");

/**
 * Mutating App secret operations. The App is fixed when the client is
 * bound, so no `app_name` is passed per call.
 */
export interface WriteSecretClient {
  /** Create or upsert a secret by name. */
  create(
    name: string,
    value: Redacted.Redacted<string> | string,
  ): Effect.Effect<SetAppSecretResponse, SecretCreateError, RuntimeContext>;
  /** Update secrets by name (batch of one). */
  update(
    name: string,
    value: Redacted.Redacted<string> | string,
  ): Effect.Effect<AppSecretsUpdateResp, SecretsUpdateError, RuntimeContext>;
  /** Delete a secret by name. */
  delete(
    name: string,
  ): Effect.Effect<DeleteAppSecretResponse, SecretDeleteError, RuntimeContext>;
}
