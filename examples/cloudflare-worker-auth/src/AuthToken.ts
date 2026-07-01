import { Random } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/** Secrets Store backing the bearer token. */
export const Store = Cloudflare.SecretsStore.Store("AuthSecrets");

/**
 * Random-generated bearer token. `Random` persists its value in state, so the
 * token is stable across deploys (only regenerated on replacement).
 *
 * `yield* AuthTokenValue` resolves to `{ text: Output<Redacted<string>> }` —
 * yield it in the stack to read `.text` for the `authToken` output.
 */
export const AuthTokenValue = Random("AuthTokenValue");

/** Cloudflare Secret bound to the Worker. Internal — yielded by `Api`. */
export const AuthToken = Effect.gen(function* () {
  const store = yield* Store;
  const value = yield* AuthTokenValue;
  return yield* Cloudflare.SecretsStore.Secret("AuthToken", {
    store,
    value: value.text,
  });
});
