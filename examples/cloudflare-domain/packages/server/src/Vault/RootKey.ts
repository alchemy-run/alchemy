import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

/**
 * The key every customer's key is wrapped under, kept in Secrets Store. It is
 * made on the first deploy and kept in the Stack's state.
 */
export const RootKey = Effect.gen(function* () {
  const store = yield* Cloudflare.SecretsStore.Store("BankSecrets");
  const value = yield* Alchemy.Random("VaultRootKeyValue");
  return yield* Cloudflare.SecretsStore.Secret("VaultRootKey", { store, value: value.text });
});
