import type {
  AppSecret,
  SecretGetError,
} from "@distilled.cloud/fly-io/machines";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Secret } from "./Secret.ts";
import type { WriteSecretClient } from "./WriteSecret.ts";

/**
 * Binding that lets runtime code get, create, update, and delete Fly.io
 * App secrets. Listing is {@link ListSecrets} on the App — it is not
 * a Secret-scoped operation.
 *
 * Authenticates with a deploy token minted via `appCreateDeployToken` when
 * the host is a {@link Machine} or {@link Service}, and with the ambient
 * `FLY_API_TOKEN` inside an Action. The App is fixed by
 * `ReadWriteSecret(secret)` so calls take no `app_name`. Provide
 * {@link ReadWriteSecretHttp} on the Action / Service Effect.
 *
 * @binding
 *
 * @section Managing secrets at runtime
 * @example Get and mutate from an Action
 * Bind the client in the Action's Init phase and provide
 * {@link ReadWriteSecretHttp}.
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Fly from "alchemy/Fly";
 * import * as Effect from "effect/Effect";
 * import * as Redacted from "effect/Redacted";
 *
 * const Seed = Alchemy.Action(
 *   "Seed",
 *   Effect.gen(function* () {
 *     const secrets = yield* Fly.ReadWriteSecret(dbUrl);
 *     return Effect.fn(function* () {
 *       const got = yield* secrets.get();
 *       yield* secrets.create("API_KEY", Redacted.make("sk_live"));
 *       yield* secrets.update("API_KEY", Redacted.make("sk_live_rotated"));
 *       yield* secrets.delete("API_KEY");
 *       return got.name;
 *     });
 *   }).pipe(Effect.provide(Fly.ReadWriteSecretHttp)),
 * );
 * ```
 */
export interface ReadWriteSecret extends Binding.Service<
  ReadWriteSecret,
  "Fly.ReadWriteSecret",
  (secret: Secret) => Effect.Effect<ReadWriteSecretClient>
> {}

export const ReadWriteSecret = Binding.Service<ReadWriteSecret>(
  "Fly.ReadWriteSecret",
);

/** Combined get + write App secret operations. */
export interface ReadWriteSecretClient extends WriteSecretClient {
  /**
   * Fetch the bound Secret. Plaintext (`value`) is only returned from
   * inside a Machine in the same App.
   */
  get(): Effect.Effect<AppSecret, SecretGetError, RuntimeContext>;
}
