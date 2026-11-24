import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SqlClient } from "effect/sql/SqlClient";
import { KeyStore } from "./KeyStore.ts";
import { VaultError } from "./VaultError.ts";

/** Options for {@link SqlKeyStore}. */
export interface SqlKeyStoreOptions {
  /**
   * The table that holds one row per subject. It is created on first use.
   * @default "vault_keys"
   */
  readonly table?: string;
}

/**
 * A Vault's keys in a SQL database, one row per subject, over the
 * `SqlClient` you provide, on Postgres. Use a database whose backups
 * you control: a restored backup brings shredded keys back.
 *
 * ### Keeping keys in Postgres
 * **Example:** Keys in a database of their own
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import { SqlKeyStore } from "@alchemy.run/domain/SqlKeyStore";
 * import { PgClient } from "@effect/sql-pg";
 * import * as Config from "effect/Config";
 * import * as Layer from "effect/Layer";
 *
 * export const Sealing = Domain.VaultLive.pipe(
 *   Layer.provide(SqlKeyStore()),
 *   Layer.provide(Domain.RootKeyWrap(Config.Redacted("VAULT_ROOT_KEY"))),
 *   Layer.provide(PgClient.layerConfig({ url: Config.Redacted("VAULT_DATABASE_URL") })),
 * );
 * ```
 *
 * @layer
 * @provides Domain.KeyStore
 */
export const SqlKeyStore = (
  options: SqlKeyStoreOptions = {},
): Layer.Layer<KeyStore, never, SqlClient> =>
  Layer.effect(
    KeyStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const table = sql((options.table ?? "vault_keys").replace(/[^A-Za-z0-9_]/g, "_"));
      const failed = (subject: string) => (cause: { readonly message: string }) =>
        VaultError.make({ subject, reason: cause.message });
      // Once per process: the table is the store's own.
      let created = false;
      const ready = Effect.suspend(() =>
        created
          ? Effect.void
          : sql`CREATE TABLE IF NOT EXISTS ${table} (subject TEXT PRIMARY KEY, key TEXT NOT NULL)`.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  created = true;
                }),
              ),
            ),
      );
      const get = (subject: string) =>
        ready.pipe(
          Effect.andThen(
            sql<{ readonly key: string }>`SELECT key FROM ${table} WHERE subject = ${subject}`,
          ),
          Effect.map((rows) => Option.fromNullishOr(rows[0]?.key)),
          Effect.mapError(failed(subject)),
        );
      return {
        get,
        // Two callers may store a key for one subject at once: the first row wins, and both read it.
        create: (subject, key) =>
          ready.pipe(
            Effect.andThen(
              sql`INSERT INTO ${table} (subject, key) VALUES (${subject}, ${key}) ON CONFLICT (subject) DO NOTHING`,
            ),
            Effect.mapError(failed(subject)),
            Effect.andThen(get(subject)),
            Effect.map(Option.getOrElse(() => key)),
          ),
        delete: (subject) =>
          ready.pipe(
            Effect.andThen(sql`DELETE FROM ${table} WHERE subject = ${subject}`),
            Effect.asVoid,
            Effect.mapError(failed(subject)),
          ),
      };
    }),
  );
