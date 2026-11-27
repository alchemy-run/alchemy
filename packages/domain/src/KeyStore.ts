import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { VaultError } from "./VaultError.ts";

/**
 * Where a Vault keeps one key per subject, as the text {@link KeyWrap} made
 * of it. Its methods may need the runtime they run in (`RuntimeContext`), as
 * a database binding does.
 *
 * A backup of the store that is restored brings shredded keys back: keep it
 * somewhere whose backups you control, apart from the model's own.
 *
 * ### Writing a key store
 * **Example:** Keys in a table of your own
 * ```typescript
 * export const MyKeyStore = Layer.effect(
 *   Domain.KeyStore,
 *   Effect.gen(function* () {
 *     const table = yield* Keys;
 *     return {
 *       get: (subject) => table.find(subject),
 *       // The first key stored for a subject wins: return the one it has now.
 *       create: (subject, key) => table.insertIfAbsent(subject, key),
 *       delete: (subject) => table.remove(subject),
 *     };
 *   }),
 * );
 * ```
 */
export class KeyStore extends Context.Service<
  KeyStore,
  {
    /** The subject's stored key, if it has one. */
    readonly get: (
      subject: string,
    ) => Effect.Effect<Option.Option<string>, VaultError, RuntimeContext>;
    /**
     * Store `key` for a subject that has none, and return the key the
     * subject now has: `key`, or the one another caller stored first.
     */
    readonly create: (
      subject: string,
      key: string,
    ) => Effect.Effect<string, VaultError, RuntimeContext>;
    /** Remove the subject's key for good. Removing a key that is not there is not an error. */
    readonly delete: (subject: string) => Effect.Effect<void, VaultError, RuntimeContext>;
  }
>()("alchemy/Domain/KeyStore") {}

/** A key store over a map. @internal */
export const memoryKeys = (): KeyStore["Service"] => {
  const keys = new Map<string, string>();
  return {
    get: (subject) => Effect.sync(() => Option.fromNullishOr(keys.get(subject))),
    create: (subject, key) =>
      Effect.sync(() => {
        const existing = keys.get(subject);
        if (existing !== undefined) return existing;
        keys.set(subject, key);
        return key;
      }),
    delete: (subject) => Effect.sync(() => void keys.delete(subject)),
  };
};
