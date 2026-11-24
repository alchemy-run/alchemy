import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { KeyWrap, rootKeyWrap } from "./KeyWrap.ts";

/**
 * Wrap each subject's key under a root key you supply, so the
 * {@link KeyStore} alone opens nothing. The root key is a high-entropy
 * secret: 32 random bytes as text, not a password.
 *
 * **Example:** A root key from the environment
 * ```typescript
 * export const BankLive = Bank.layer(BankHandlers).pipe(
 *   Layer.provide(Domain.VaultLive),
 *   Layer.provide(Domain.HostKeyStore),
 *   Layer.provide(Domain.RootKeyWrap(Config.Redacted("VAULT_ROOT_KEY"))),
 *   Layer.provide(Platform),
 * );
 * ```
 *
 * @layer
 * @provides Domain.KeyWrap
 */
export const RootKeyWrap = (
  root: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>,
): Layer.Layer<KeyWrap> =>
  Layer.succeed(
    KeyWrap,
    rootKeyWrap(Redacted.isRedacted(root) ? Effect.succeed(root) : root.pipe(Effect.orDie)),
  );
