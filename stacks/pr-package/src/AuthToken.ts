import { Random } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Store } from "./Store.ts";

export const AuthTokenValue = Random("AuthTokenValue");

export const AuthToken = Effect.gen(function* () {
  const store = yield* Store;
  const authToken = yield* AuthTokenValue;

  return yield* Cloudflare.Secret("PrPackageAuthToken", {
    store,
    value: authToken.text,
  });
});
