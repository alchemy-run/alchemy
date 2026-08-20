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
 * Create, update, and delete Fly.io App secrets at runtime.
 *
 * The App is fixed by `WriteSecret(secret)`. Calls take no
 * `app_name`. Inside a {@link Machine} or {@link Service}, Alchemy
 * mints an App deploy token. Inside an Action, the ambient
 * `FLY_API_TOKEN` is used.
 *
 * @binding
 *
 * @section Create
 * Bind the client in init. Provide {@link WriteSecretHttp}. Wrap
 * values with `Redacted.make`.
 *
 * @example Create a secret
 * ```typescript
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const secrets = yield* Fly.WriteSecret(ApiToken);
 *
 *     return Effect.fn(function* () {
 *       yield* secrets.create("API_KEY", Redacted.make("sk_live"));
 *     });
 *   }).pipe(Effect.provide(Fly.WriteSecretHttp)),
 * );
 * ```
 *
 * @section Update
 * `update` rotates by name (batch of one).
 *
 * @example Rotate
 * ```typescript
 * yield* secrets.update("API_KEY", Redacted.make("sk_live_rotated"));
 * ```
 *
 * @section Delete
 * `delete` removes a secret by name.
 *
 * @example Delete
 * ```typescript
 * yield* secrets.delete("API_KEY");
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
