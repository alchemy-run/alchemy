import {
  createLocalAccountIssuer,
  createOAuthAccountIssuer,
  getAuthTables,
} from "better-auth/db";
import type { BetterAuthOptions } from "better-auth";
import type { Kysely, Sql } from "kysely";
import * as Effect from "effect/Effect";
import type { DirectDatabase } from "./Database.ts";
import { BetterAuthMigrationError } from "./Errors.ts";

type Dialect = "sqlite" | "postgres" | "mysql" | "mssql";
type AuthKysely = Kysely<Record<string, Record<string, unknown>>>;
type InspectedTable = {
  readonly name: string;
  readonly columns: ReadonlyArray<{
    readonly name: string;
    readonly isNullable: boolean;
  }>;
};

interface Upgrade {
  readonly sql: Sql;
  readonly db: AuthKysely;
  readonly dbType: Dialect;
  readonly options: BetterAuthOptions;
  readonly tables: InspectedTable[];
}

/**
 * Backfill `account.issuer` and refuse leftover tables that `getMigrations`
 * cannot convert. Dynamically imported with the rest of Migrate.ts.
 *
 * @internal
 */
export const prepareSchemaUpgrades = (
  options: BetterAuthOptions,
  database: DirectDatabase,
): Effect.Effect<void, BetterAuthMigrationError> =>
  Effect.gen(function* () {
    const { createKyselyAdapter } = yield* Effect.promise(
      () => import("@better-auth/kysely-adapter"),
    );
    const { sql } = yield* Effect.promise(() => import("kysely"));
    const { kysely, databaseType } = yield* kyselyCall(() =>
      createKyselyAdapter({
        ...options,
        database,
        secret: "alchemy-migrate",
        telemetry: { enabled: false },
      }),
    );
    if (kysely === null) {
      return;
    }
    const db = kysely as AuthKysely;
    const tables = yield* kyselyCall(() => db.introspection.getTables());
    const upgrade: Upgrade = {
      sql,
      db,
      dbType: databaseType ?? "sqlite",
      options,
      tables,
    };
    yield* refusePopulatedLegacyTable(
      upgrade,
      "scimProvider",
      "Legacy SCIM tables are populated. The current SCIM models cannot be converted in place — follow the SCIM cutover in https://www.better-auth.com/docs/guides/1-7-upgrade-guide#scim-requires-full-reprovisioning before deploying.",
    );
    yield* refusePopulatedLegacyTable(
      upgrade,
      "oauthApplication",
      "Legacy `oauthApplication` rows are present. Copy or re-register each client as `oauthClient` before deploying — see https://www.better-auth.com/docs/guides/1-7-upgrade-guide#migrate-oauth-client-records.",
    );
    yield* refuseDuplicateDeviceCodes(upgrade);
    yield* backfillAccountIdentity(upgrade);
  });

const MICROSOFT_PROVIDER_IDS = new Set(["microsoft", "microsoft-entra-id"]);

const KNOWN_ISSUERS: Readonly<Record<string, string>> = {
  google: "https://accounts.google.com",
  apple: "https://appleid.apple.com",
  facebook: "https://www.facebook.com",
  line: "https://access.line.me",
  slack: "https://slack.com",
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const fail = (
  message: string,
): Effect.Effect<never, BetterAuthMigrationError> =>
  Effect.fail(new BetterAuthMigrationError({ message }));

const kyselyCall = <A>(
  task: () => Promise<A>,
): Effect.Effect<A, BetterAuthMigrationError> =>
  Effect.tryPromise({
    try: task,
    catch: (cause) =>
      new BetterAuthMigrationError({
        message: "Failed to prepare Better Auth schema upgrades",
        cause,
      }),
  });

const assertIdent = (
  name: string,
): Effect.Effect<string, BetterAuthMigrationError> =>
  IDENT.test(name)
    ? Effect.succeed(name)
    : fail(`Unsafe SQL identifier "${name}"`);

const quoteIdent = (
  name: string,
): Effect.Effect<string, BetterAuthMigrationError> =>
  Effect.map(assertIdent(name), (ident) => `"${ident}"`);

const stringField = (value: unknown, key: string): string | undefined => {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
};

const decodeJwtPayload = (
  token: string,
): Effect.Effect<Record<string, unknown> | undefined> =>
  Effect.sync(() => {
    const parts = token.split(".");
    if (parts.length < 2 || parts[1] === undefined) {
      return undefined;
    }
    try {
      const json = Buffer.from(parts[1], "base64url").toString("utf8");
      const payload: unknown = JSON.parse(json);
      return payload !== null && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  });

const execRaw = (upgrade: Upgrade, statement: string) =>
  kyselyCall(() =>
    upgrade.sql`${upgrade.sql.raw(statement)}`.execute(upgrade.db),
  );

/** Microsoft issuers come from the stored ID token, not this map. */
export const issuerByProviderId = (options: {
  readonly socialProviders?: BetterAuthOptions["socialProviders"];
  readonly plugins?: ReadonlyArray<{
    readonly id?: string;
    readonly options?: { readonly config?: unknown };
  }>;
}): Map<string, string> => {
  const issuers = new Map<string, string>(Object.entries(KNOWN_ISSUERS));
  issuers.set("credential", createLocalAccountIssuer("credential"));
  issuers.set("siwe", createLocalAccountIssuer("siwe"));

  const cognito = options.socialProviders?.cognito;
  const cognitoRegion = stringField(cognito, "region");
  const cognitoPool = stringField(cognito, "userPoolId");
  if (cognitoRegion !== undefined && cognitoPool !== undefined) {
    issuers.set(
      "cognito",
      `https://cognito-idp.${cognitoRegion}.amazonaws.com/${cognitoPool}`,
    );
  }

  const paybinIssuer = stringField(options.socialProviders?.paybin, "issuer");
  if (paybinIssuer !== undefined) {
    issuers.set("paybin", paybinIssuer);
  }

  for (const plugin of options.plugins ?? []) {
    if (plugin.id !== "generic-oauth") {
      continue;
    }
    const config = plugin.options?.config;
    if (!Array.isArray(config)) {
      continue;
    }
    for (const entry of config) {
      const providerId = stringField(entry, "providerId");
      const accountIssuer = stringField(entry, "accountIssuer");
      if (providerId !== undefined && accountIssuer !== undefined) {
        issuers.set(providerId, accountIssuer);
      }
    }
  }

  return issuers;
};

const tableHasRows = (
  upgrade: Upgrade,
  table: string,
): Effect.Effect<boolean, BetterAuthMigrationError> =>
  kyselyCall(() =>
    upgrade.sql<{ present: number }>`
      SELECT 1 AS present FROM ${upgrade.sql.table(table)} LIMIT 1
    `.execute(upgrade.db),
  ).pipe(Effect.map((result) => result.rows.length > 0));

const refusePopulatedLegacyTable = (
  upgrade: Upgrade,
  table: string,
  message: string,
): Effect.Effect<void, BetterAuthMigrationError> =>
  Effect.gen(function* () {
    if (!upgrade.tables.some((candidate) => candidate.name === table)) {
      return;
    }
    if (yield* tableHasRows(upgrade, table)) {
      return yield* fail(message);
    }
  });

const refuseDuplicateDeviceCodes = (
  upgrade: Upgrade,
): Effect.Effect<void, BetterAuthMigrationError> =>
  Effect.gen(function* () {
    const device = upgrade.tables.find((table) => table.name === "deviceCode");
    if (device === undefined) {
      return;
    }
    const columns = new Set(device.columns.map((column) => column.name));
    yield* Effect.forEach(
      ["deviceCode", "userCode"] as const,
      (column) =>
        Effect.gen(function* () {
          if (!columns.has(column)) {
            return;
          }
          const duplicates = yield* kyselyCall(() =>
            upgrade.sql<{ n: number | string }>`
              SELECT COUNT(*) AS n
              FROM ${upgrade.sql.table("deviceCode")}
              WHERE ${upgrade.sql.ref(column)} IS NOT NULL
              GROUP BY ${upgrade.sql.ref(column)}
              HAVING COUNT(*) > 1
              LIMIT 1
            `.execute(upgrade.db),
          );
          if (duplicates.rows.length > 0) {
            return yield* fail(
              `Duplicate ${column} values on deviceCode block the unique index. Deduplicate those rows, then re-deploy.`,
            );
          }
        }),
      { concurrency: 1 },
    );
  });

const backfillAccountIdentity = (
  upgrade: Upgrade,
): Effect.Effect<void, BetterAuthMigrationError> =>
  Effect.gen(function* () {
    const account = getAuthTables(upgrade.options).account;
    if (account === undefined) {
      return;
    }
    const table = yield* assertIdent(account.modelName);
    const issuerCol = yield* assertIdent(
      account.fields.issuer?.fieldName || "issuer",
    );
    const accountIdCol = yield* assertIdent(
      account.fields.accountId?.fieldName || "accountId",
    );
    const providerIdCol = yield* assertIdent(
      account.fields.providerId?.fieldName || "providerId",
    );
    const userIdCol = yield* assertIdent(
      account.fields.userId?.fieldName || "userId",
    );
    const idTokenCol = yield* assertIdent(
      account.fields.idToken?.fieldName || "idToken",
    );

    const existing = upgrade.tables.find(
      (candidate) => candidate.name === table,
    );
    if (existing === undefined) {
      return;
    }

    const issuerColumn = existing.columns.find(
      (column) => column.name === issuerCol,
    );
    const hasRows = yield* tableHasRows(upgrade, table);
    if (!hasRows && issuerColumn === undefined) {
      return;
    }

    if (issuerColumn === undefined) {
      const columnType =
        upgrade.dbType === "mysql" || upgrade.dbType === "mssql"
          ? "varchar(255)"
          : "text";
      yield* kyselyCall(() =>
        upgrade.db.schema
          .alterTable(table)
          .addColumn(issuerCol, columnType)
          .execute(),
      );
    } else if (upgrade.dbType === "mysql") {
      yield* dropCorruptedMysqlIssuerIndex(upgrade, table, issuerCol);
    }

    const issuers = issuerByProviderId(upgrade.options);
    const providerIds = yield* kyselyCall(() =>
      upgrade.db.selectFrom(table).select(providerIdCol).distinct().execute(),
    );

    yield* Effect.forEach(
      providerIds,
      (row) =>
        Effect.gen(function* () {
          const providerId = String(row[providerIdCol] ?? "");
          if (
            providerId.length === 0 ||
            MICROSOFT_PROVIDER_IDS.has(providerId)
          ) {
            return;
          }
          const issuer =
            issuers.get(providerId) ?? createOAuthAccountIssuer(providerId);
          if (providerId === "credential") {
            yield* kyselyCall(() =>
              upgrade.db
                .updateTable(table)
                .set({
                  [issuerCol]: issuer,
                  [accountIdCol]: upgrade.sql.ref(userIdCol),
                })
                .where(providerIdCol, "=", providerId)
                .execute(),
            );
            return;
          }
          yield* kyselyCall(() =>
            upgrade.db
              .updateTable(table)
              .set({ [issuerCol]: issuer })
              .where(providerIdCol, "=", providerId)
              .where((eb) =>
                eb.or([eb(issuerCol, "is", null), eb(issuerCol, "=", "")]),
              )
              .execute(),
          );
        }),
      { concurrency: 1 },
    );

    yield* backfillMicrosoftRows(upgrade, {
      table,
      issuerCol,
      accountIdCol,
      providerIdCol,
      idTokenCol,
      hasIdToken: existing.columns.some((column) => column.name === idTokenCol),
    });

    const unmapped = yield* kyselyCall(() =>
      upgrade.sql<{ id: unknown; provider: unknown }>`
        SELECT id, ${upgrade.sql.ref(providerIdCol)} AS provider
        FROM ${upgrade.sql.table(table)}
        WHERE ${upgrade.sql.ref(issuerCol)} IS NULL OR ${upgrade.sql.ref(issuerCol)} = ''
        LIMIT 10
      `.execute(upgrade.db),
    );
    if (unmapped.rows.length > 0) {
      const providers = [
        ...new Set(unmapped.rows.map((row) => String(row.provider))),
      ].join(", ");
      const microsoft = unmapped.rows.some((row) =>
        MICROSOFT_PROVIDER_IDS.has(String(row.provider)),
      );
      return yield* fail(
        `Could not backfill account.issuer for providerId(s): ${providers}. ${
          microsoft
            ? "Microsoft rows need a stored ID token carrying oid and iss, or a trusted Entra export — Better Auth cannot derive oid from the old account row."
            : "Supply a static accountIssuer on the provider (or a generic OAuth config) so deploy can assign a trusted issuer."
        }`,
      );
    }

    const collisions = yield* kyselyCall(() =>
      upgrade.sql<{
        issuer: unknown;
        accountId: unknown;
      }>`
        SELECT ${upgrade.sql.ref(issuerCol)} AS issuer, ${upgrade.sql.ref(accountIdCol)} AS accountId
        FROM ${upgrade.sql.table(table)}
        GROUP BY ${upgrade.sql.ref(issuerCol)}, ${upgrade.sql.ref(accountIdCol)}
        HAVING COUNT(*) > 1
        LIMIT 5
      `.execute(upgrade.db),
    );
    if (collisions.rows.length > 0) {
      const sample = collisions.rows
        .map((row) => `(${String(row.issuer)}, ${String(row.accountId)})`)
        .join(", ");
      return yield* fail(
        `Account identity collisions on (issuer, accountId): ${sample}. Reconcile duplicate rows for the same user or establish the owner from trusted provider data before re-deploying.`,
      );
    }

    if (issuerColumn?.isNullable !== false) {
      yield* enforceIssuerNotNull(upgrade, table, issuerCol);
    }
  });

const dropCorruptedMysqlIssuerIndex = (
  upgrade: Upgrade,
  table: string,
  issuerCol: string,
): Effect.Effect<void, BetterAuthMigrationError> =>
  Effect.gen(function* () {
    const empty = yield* kyselyCall(() =>
      upgrade.sql<{ present: number }>`
        SELECT 1 AS present FROM ${upgrade.sql.table(table)}
        WHERE ${upgrade.sql.ref(issuerCol)} IS NULL OR ${upgrade.sql.ref(issuerCol)} = ''
        LIMIT 1
      `.execute(upgrade.db),
    );
    if (empty.rows.length === 0) {
      return;
    }
    const indexName = `${table}_issuer_accountId_uidx`;
    const indexes = yield* kyselyCall(() =>
      upgrade.sql<{ Key_name?: string }>`
        SHOW INDEX FROM ${upgrade.sql.table(table)}
      `.execute(upgrade.db),
    );
    if (!indexes.rows.some((row) => row.Key_name === indexName)) {
      return;
    }
    yield* kyselyCall(() =>
      upgrade.db.schema.dropIndex(indexName).on(table).execute(),
    );
  });

const backfillMicrosoftRows = (
  upgrade: Upgrade,
  cols: {
    table: string;
    issuerCol: string;
    accountIdCol: string;
    providerIdCol: string;
    idTokenCol: string;
    hasIdToken: boolean;
  },
): Effect.Effect<void, BetterAuthMigrationError> =>
  Effect.gen(function* () {
    if (!cols.hasIdToken) {
      return;
    }

    const rows = yield* kyselyCall(() =>
      upgrade.db
        .selectFrom(cols.table)
        .select(["id", cols.providerIdCol, cols.idTokenCol, cols.issuerCol])
        .where(cols.providerIdCol, "in", [...MICROSOFT_PROVIDER_IDS])
        .execute(),
    );

    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const existingIssuer = row[cols.issuerCol];
          if (typeof existingIssuer === "string" && existingIssuer.length > 0) {
            return;
          }
          const token = row[cols.idTokenCol];
          if (typeof token !== "string" || token.length === 0) {
            return;
          }
          const payload = yield* decodeJwtPayload(token);
          const issuer = payload?.iss;
          const oid = payload?.oid;
          if (typeof issuer !== "string" || typeof oid !== "string") {
            return;
          }
          yield* kyselyCall(() =>
            upgrade.db
              .updateTable(cols.table)
              .set({
                [cols.issuerCol]: issuer,
                [cols.accountIdCol]: oid,
              })
              .where("id", "=", row.id)
              .execute(),
          );
        }),
      { concurrency: 1 },
    );
  });

const enforceIssuerNotNull = (
  upgrade: Upgrade,
  table: string,
  issuerCol: string,
): Effect.Effect<void, BetterAuthMigrationError> => {
  switch (upgrade.dbType) {
    case "postgres":
      return kyselyCall(() =>
        upgrade.sql`ALTER TABLE ${upgrade.sql.table(table)} ALTER COLUMN ${upgrade.sql.ref(issuerCol)} SET NOT NULL`.execute(
          upgrade.db,
        ),
      ).pipe(Effect.asVoid);
    case "mysql":
      return kyselyCall(() =>
        upgrade.sql`ALTER TABLE ${upgrade.sql.table(table)} MODIFY COLUMN ${upgrade.sql.ref(issuerCol)} VARCHAR(255) NOT NULL`.execute(
          upgrade.db,
        ),
      ).pipe(Effect.asVoid);
    case "mssql":
      return kyselyCall(() =>
        upgrade.sql`ALTER TABLE ${upgrade.sql.table(table)} ALTER COLUMN ${upgrade.sql.ref(issuerCol)} VARCHAR(255) NOT NULL`.execute(
          upgrade.db,
        ),
      ).pipe(Effect.asVoid);
    case "sqlite":
      return rebuildSqliteIssuerNotNull(upgrade, table, issuerCol);
    default: {
      const _exhaustive: never = upgrade.dbType;
      return _exhaustive;
    }
  }
};

const rebuildSqliteIssuerNotNull = (
  upgrade: Upgrade,
  table: string,
  issuerCol: string,
): Effect.Effect<void, BetterAuthMigrationError> =>
  Effect.gen(function* () {
    const quotedTable = yield* quoteIdent(table);
    const info = yield* kyselyCall(() =>
      upgrade.sql<{
        name: string;
        type: string;
        notnull: number | bigint;
        dflt_value: string | number | null;
        pk: number | bigint;
      }>`PRAGMA table_info(${upgrade.sql.raw(quotedTable)})`.execute(
        upgrade.db,
      ),
    );
    const foreignKeys = yield* kyselyCall(() =>
      upgrade.sql<{
        table: string;
        from: string;
        to: string;
        on_delete: string;
        on_update: string;
      }>`PRAGMA foreign_key_list(${upgrade.sql.raw(quotedTable)})`.execute(
        upgrade.db,
      ),
    );
    const indexes = yield* kyselyCall(() =>
      upgrade.sql<{ sql: string }>`
        SELECT sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = ${table} AND sql IS NOT NULL
      `.execute(upgrade.db),
    );

    const replacement = `${table}__alchemy_issuer`;
    yield* assertIdent(replacement);
    const columnSql = yield* Effect.forEach(info.rows, (column) =>
      Effect.gen(function* () {
        const quoted = yield* quoteIdent(column.name);
        const type = column.type.length > 0 ? column.type : "TEXT";
        const notNull =
          column.name === issuerCol || Number(column.notnull) === 1
            ? " NOT NULL"
            : "";
        const defaultValue =
          column.dflt_value !== null && column.dflt_value !== undefined
            ? ` DEFAULT ${column.dflt_value}`
            : "";
        const primaryKey = Number(column.pk) === 1 ? " PRIMARY KEY" : "";
        return `${quoted} ${type}${notNull}${defaultValue}${primaryKey}`;
      }),
    );
    const fkSql = yield* Effect.forEach(foreignKeys.rows, (fk) =>
      Effect.gen(function* () {
        const from = yield* quoteIdent(fk.from);
        const referenced = yield* quoteIdent(fk.table);
        const to = yield* quoteIdent(fk.to);
        return `FOREIGN KEY (${from}) REFERENCES ${referenced} (${to}) ON DELETE ${fk.on_delete} ON UPDATE ${fk.on_update}`;
      }),
    );

    const quotedReplacement = yield* quoteIdent(replacement);
    const columnList = (yield* Effect.forEach(info.rows, (column) =>
      quoteIdent(column.name),
    )).join(", ");

    yield* kyselyCall(() =>
      upgrade.sql`PRAGMA foreign_keys = OFF`.execute(upgrade.db),
    );
    yield* Effect.gen(function* () {
      yield* execRaw(
        upgrade,
        `CREATE TABLE ${quotedReplacement} (${[...columnSql, ...fkSql].join(", ")})`,
      );
      yield* execRaw(
        upgrade,
        `INSERT INTO ${quotedReplacement} (${columnList}) SELECT ${columnList} FROM ${quotedTable}`,
      );
      yield* execRaw(upgrade, `DROP TABLE ${quotedTable}`);
      yield* execRaw(
        upgrade,
        `ALTER TABLE ${quotedReplacement} RENAME TO ${quotedTable}`,
      );
      yield* Effect.forEach(
        indexes.rows,
        (index) => execRaw(upgrade, index.sql),
        { concurrency: 1 },
      );
    }).pipe(
      Effect.ensuring(
        kyselyCall(() =>
          upgrade.sql`PRAGMA foreign_keys = ON`.execute(upgrade.db),
        ).pipe(Effect.ignore),
      ),
    );
  });
