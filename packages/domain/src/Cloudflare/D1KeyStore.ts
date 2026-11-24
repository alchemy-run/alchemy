import type { Database } from "@alchemy.run/cloudflare/D1/Database";
import { QueryDatabase } from "@alchemy.run/cloudflare/D1/QueryDatabase";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { KeyStore } from "../KeyStore.ts";
import { VaultError } from "../VaultError.ts";

/** Options for {@link D1KeyStore}. */
export interface D1KeyStoreOptions {
  /**
   * The table that holds one row per subject. It is created on first use.
   * @default "vault_keys"
   */
  readonly table?: string;
}

/**
 * A Vault's keys in a D1 database, one row per subject. Give the keys a
 * database of their own: D1 Time Travel restores a database up to 30 days
 * back, deleted keys included, so wrap them with `SecretKeyWrap` and rotate
 * its root key to put older copies out of reach.
 *
 * ### Keeping keys in D1
 * **Example:** A database for the Vault's keys
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Domain from "@alchemy.run/domain";
 * import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
 * import * as Layer from "effect/Layer";
 * import { Bank, BankHandlers } from "./Bank.model.ts";
 *
 * export const KeysDatabase = Cloudflare.D1.Database("KeysDatabase");
 *
 * export const BankLive = Bank.layer(BankHandlers).pipe(
 *   Layer.provide(Domain.VaultLive),
 *   Layer.provide(DomainCloudflare.D1KeyStore(KeysDatabase)),
 *   Layer.provide(Domain.NoKeyWrap),
 *   Layer.provide(
 *     Layer.mergeAll(DomainCloudflare.layerDurableObjects(), Cloudflare.D1.QueryDatabaseBinding),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides Domain.KeyStore
 */
export const D1KeyStore = <E = never, R = never>(
  database: Database | Effect.Effect<Database, E, R>,
  options: D1KeyStoreOptions = {},
): Layer.Layer<KeyStore, E, R | QueryDatabase> =>
  Layer.effect(
    KeyStore,
    Effect.gen(function* () {
      const db = yield* QueryDatabase(Effect.isEffect(database) ? yield* database : database);
      const table = (options.table ?? "vault_keys").replace(/[^A-Za-z0-9_]/g, "_");
      const failed = (subject: string) => (cause: { readonly message: string }) =>
        VaultError.make({ subject, reason: cause.message });
      // Once per isolate: the table is the store's own.
      let created = false;
      const ready = (subject: string) =>
        Effect.suspend(() =>
          created
            ? Effect.void
            : db
                .prepare(
                  `CREATE TABLE IF NOT EXISTS ${table} (subject TEXT PRIMARY KEY, key TEXT NOT NULL)`,
                )
                .run()
                .pipe(
                  Effect.mapError(failed(subject)),
                  Effect.andThen(
                    Effect.sync(() => {
                      created = true;
                    }),
                  ),
                ),
        );
      const get = (subject: string) =>
        ready(subject).pipe(
          Effect.andThen(
            db
              .prepare(`SELECT key FROM ${table} WHERE subject = ?`)
              .bind(subject)
              .first<{ readonly key: string }>(),
          ),
          Effect.map((row) => Option.fromNullishOr(row?.key)),
          Effect.mapError(failed(subject)),
        );
      return {
        get,
        // Two callers may store a key for one subject at once: the first row wins, and both read it.
        create: (subject, key) =>
          ready(subject).pipe(
            Effect.andThen(
              db
                .prepare(
                  `INSERT INTO ${table} (subject, key) VALUES (?, ?) ON CONFLICT (subject) DO NOTHING`,
                )
                .bind(subject, key)
                .run(),
            ),
            Effect.mapError(failed(subject)),
            Effect.andThen(get(subject)),
            Effect.map(Option.getOrElse(() => key)),
          ),
        delete: (subject) =>
          ready(subject).pipe(
            Effect.andThen(
              db.prepare(`DELETE FROM ${table} WHERE subject = ?`).bind(subject).run(),
            ),
            Effect.asVoid,
            Effect.mapError(failed(subject)),
          ),
      };
    }),
  );
