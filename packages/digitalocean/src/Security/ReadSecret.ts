import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Secret } from "./Secret.ts";

/** The secret, or the requested key, is not bound to this runtime. */
export class SecretValueMissing extends Data.TaggedError(
  "DigitalOcean.Security.SecretValueMissing",
)<{
  readonly secret: string;
  readonly key: string | undefined;
}> {
  override get message() {
    return this.key === undefined
      ? `Secret '${this.secret}' is not bound to this runtime.`
      : `Secret '${this.secret}' has no key '${this.key}'.`;
  }
}

export interface ReadSecretClient {
  /** One value of the secret. */
  get(key: string): Effect.Effect<Redacted.Redacted<string>, SecretValueMissing, RuntimeContext>;
  /** Every key-value pair of the secret. */
  readonly values: Effect.Effect<
    Redacted.Redacted<Record<string, string>>,
    SecretValueMissing,
    RuntimeContext
  >;
}

/**
 * Read a secret's values from a runtime. The values reach the host as
 * secrets in its environment when it deploys, so a runtime holds no
 * DigitalOcean token: DigitalOcean signs no workload identity a runtime
 * could exchange for one. Changing the secret's values redeploys the
 * runtimes bound to it.
 *
 * **Example:** Read an API key in an App
 * ```typescript
 * const Stripe = DigitalOcean.Security.Secret("stripe", {
 *   values: { STRIPE_KEY: "sk_test_..." },
 * });
 *
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const secret = yield* Stripe;
 *     const stripe = yield* DigitalOcean.Security.ReadSecret(secret);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const key = yield* stripe.get("STRIPE_KEY");
 *         return HttpServerResponse.text(Redacted.value(key).slice(0, 7));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Security.ReadSecretHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Security
 */
export interface ReadSecret extends Binding.Service<
  ReadSecret,
  "DigitalOcean.Security.ReadSecret",
  (secret: Secret) => Effect.Effect<ReadSecretClient>
> {}

export const ReadSecret = Binding.Service<ReadSecret>("DigitalOcean.Security.ReadSecret");
