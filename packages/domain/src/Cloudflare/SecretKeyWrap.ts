import { ReadSecret } from "@alchemy.run/cloudflare/SecretsStore/ReadSecret";
import type { Secret } from "@alchemy.run/cloudflare/SecretsStore/Secret";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { KeyWrap, rootKeyWrap } from "../Vault.ts";

/**
 * Wrap each subject's key under a root key kept in Cloudflare Secrets Store,
 * read through a binding. The key store then holds nothing that opens a
 * value on its own.
 *
 * ### Wrapping keys under a Secrets Store secret
 * `Alchemy.Random` makes the root key on the first deploy and keeps it in
 * the Stack's state, so the state store is as sensitive as the secret.
 *
 * **Example:** A root key made at deploy
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Domain from "@alchemy.run/domain";
 * import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankHandlers } from "./Bank.model.ts";
 *
 * export const RootKey = Effect.gen(function* () {
 *   const store = yield* Cloudflare.SecretsStore.Store("Secrets");
 *   const random = yield* Alchemy.Random("VaultRootKeyValue");
 *   return yield* Cloudflare.SecretsStore.Secret("VaultRootKey", { store, value: random.text });
 * });
 *
 * export const BankLive = Bank.layer(BankHandlers).pipe(
 *   Layer.provide(Domain.VaultLive),
 *   Layer.provide(Domain.HostKeyStore),
 *   Layer.provide(DomainCloudflare.SecretKeyWrap(RootKey)),
 *   Layer.provide(
 *     Layer.mergeAll(
 *       DomainCloudflare.layerDurableObjects(),
 *       Cloudflare.SecretsStore.ReadSecretBinding,
 *     ),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides Domain.KeyWrap
 */
export const SecretKeyWrap = <E = never, R = never>(
  secret: Secret | Effect.Effect<Secret, E, R>,
): Layer.Layer<KeyWrap, E, R | ReadSecret> =>
  Layer.effect(
    KeyWrap,
    Effect.gen(function* () {
      const root = yield* ReadSecret(Effect.isEffect(secret) ? yield* secret : secret);
      return rootKeyWrap(root.get());
    }),
  );
