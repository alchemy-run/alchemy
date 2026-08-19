import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { Secret } from "./Secret.ts";
import type { ReadSecretClient } from "./ReadSecret.ts";
import type { WriteSecretClient } from "./WriteSecret.ts";

/**
 * Binding that lets runtime code perform the full Fly.io App secret
 * surface (read + write).
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
 * @example Full CRUD from an Action
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

/** Combined read + write App secret operations. */
export interface ReadWriteSecretClient
  extends ReadSecretClient, WriteSecretClient {}
