import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { listSqlFiles, readSqlFile, type SqlFile } from "../../Sql/SqlFile.ts";
import { recordsEqual } from "../Util.ts";
import type { Providers } from "../Providers.ts";
import {
  applyTrackedSqlFiles,
  databaseExists,
  dropDatabase,
  ensureAppRolePrivileges,
  ensureDatabase,
  ensureDatabaseOwnership,
  readAppRolePrivileges,
  readDatabaseOwnership,
  readTrackedSqlFileHashes,
  type AppRolePrivilegeState,
  type PostgresLogicalDatabaseOwner,
} from "./PostgresLogicalDatabaseClient.ts";
import type { PostgresOrigin } from "./PostgresOrigin.ts";
import * as Effect from "effect/Effect";

const DEFAULT_MIGRATIONS_TABLE = "__alchemy_migrations";
const DEFAULT_IMPORTS_TABLE = "__alchemy_imports";
const DEFAULT_OWNERSHIP_TABLE = "__alchemy_logical_database_ownership";
const DEFAULT_APP_ROLE_PRIVILEGES_VERSION = 0;
const POSTGRES_LOGICAL_DATABASE_RESOURCE_TYPE =
  "Planetscale.PostgresLogicalDatabase";
const POSTGRES_LOGICAL_DATABASE_OWNER_VERSION = 1;

/**
 * Properties for creating or updating a logical PostgreSQL database inside a
 * PlanetScale PostgreSQL database branch.
 */
export interface PostgresLogicalDatabaseProps {
  /**
   * Logical PostgreSQL database name. If omitted, Alchemy generates a
   * lowercase underscore-delimited name.
   */
  name?: string;

  /**
   * Admin PostgreSQL connection origin for the PlanetScale branch. Use an
   * origin from a {@link PostgresRole} that inherits `postgres`.
   */
  adminOrigin: PostgresOrigin;

  /**
   * Postgres-visible application role name to grant access to this logical
   * database. PlanetScale connection usernames often contain a suffix; pass
   * the visible role prefix.
   */
  appRoleName?: string;

  /**
   * Bump this value to force re-checking and re-applying application role
   * grants even when the privilege hash has not otherwise changed.
   * @default 0
   */
  appRolePrivilegesVersion?: number;

  /**
   * Directory of SQL migration files to apply once. Applied file hashes are
   * tracked in the logical database and changed or removed migration records
   * are rejected.
   */
  migrationsDir?: string;

  /**
   * Table used to track applied migrations.
   * @default "__alchemy_migrations"
   */
  migrationsTable?: string;

  /**
   * SQL files to apply as imports/seed data. Imports are re-applied when the
   * file hash changes, while removed tracked import records are rejected.
   */
  importFiles?: ReadonlyArray<string>;

  /**
   * Table used to track applied imports.
   * @default "__alchemy_imports"
   */
  importsTable?: string;
}

/**
 * Output attributes of a deployed logical PostgreSQL database.
 */
export interface PostgresLogicalDatabaseAttributes {
  /** Logical PostgreSQL database name. */
  name: string;
  /** Application role name that receives table and sequence grants. */
  appRoleName?: string;
  /** Hash of observed app-role privilege state. */
  appRolePrivilegesHash?: string;
  /** Desired application role privileges version. */
  appRolePrivilegesVersion: number;
  /** Applied migration file hashes keyed by SQL file id. */
  migrationsHashes: Record<string, string>;
  /** Applied import file hashes keyed by SQL file path. */
  importHashes: Record<string, string>;
  /** Table used to track applied migrations. */
  migrationsTable: string;
  /** Table used to track applied imports. */
  importsTable: string;
  /** Ownership marker written inside the logical database. */
  owner: PostgresLogicalDatabaseOwner;
  /** Table used to track Alchemy ownership. */
  ownershipTable: string;
}

/**
 * A logical PostgreSQL database created inside a PlanetScale PostgreSQL
 * database branch.
 *
 * Use this when one PlanetScale PostgreSQL database/branch should host
 * multiple app databases that each need separate migrations, imports, and app
 * role grants.
 *
 * @section Creating a Logical Database
 * @example Logical database with migrations
 * ```typescript
 * const admin = yield* Planetscale.PostgresRole("Admin", {
 *   database,
 *   inheritedRoles: ["postgres"],
 * });
 *
 * const app = yield* Planetscale.PostgresRole("App", {
 *   database,
 *   inheritedRoles: [],
 * });
 *
 * const logicalDb = yield* Planetscale.PostgresLogicalDatabase("AppDb", {
 *   name: "app",
 *   adminOrigin: admin.origin,
 *   appRoleName: Planetscale.postgresRoleNameFromUsername(app.username),
 *   migrationsDir: "./migrations",
 * });
 * ```
 *
 * @section Imports
 * @example Apply seed files
 * ```typescript
 * const logicalDb = yield* Planetscale.PostgresLogicalDatabase("SeededDb", {
 *   name: "seeded",
 *   adminOrigin: admin.origin,
 *   importFiles: ["./seed/users.sql"],
 * });
 * ```
 */
export type PostgresLogicalDatabase = Resource<
  "Planetscale.PostgresLogicalDatabase",
  PostgresLogicalDatabaseProps,
  PostgresLogicalDatabaseAttributes,
  never,
  Providers
>;

export const PostgresLogicalDatabase = Resource<PostgresLogicalDatabase>(
  "Planetscale.PostgresLogicalDatabase",
);

export const postgresRoleNameFromUsername = (username: string) =>
  username.split(".")[0] ?? username;

const ensurePostgresIdentifierPrefix = (name: string) =>
  /^[a-z]/.test(name) ? name : `db_${name}`.slice(0, 63);

const createLogicalDatabaseName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return ensurePostgresIdentifierPrefix(
      yield* createPhysicalName({
        id,
        delimiter: "_",
        lowercase: true,
        maxLength: 63,
      }),
    );
  });

const logicalDatabaseOwner = (
  logicalId: string,
): PostgresLogicalDatabaseOwner => ({
  logicalId,
  resourceType: POSTGRES_LOGICAL_DATABASE_RESOURCE_TYPE,
  version: POSTGRES_LOGICAL_DATABASE_OWNER_VERSION,
});

const ownersEqual = (
  left: PostgresLogicalDatabaseOwner | undefined,
  right: PostgresLogicalDatabaseOwner,
) =>
  left?.logicalId === right.logicalId &&
  left.resourceType === right.resourceType &&
  left.version === right.version;

const excludedAppRoleTableNames = (
  migrationsTable: string,
  importsTable: string,
  ownershipTable: string,
) => [migrationsTable, importsTable, ownershipTable];

const renameError = (oldName: string, newName: string) =>
  new Error(
    `Refusing to rename logical Postgres database "${oldName}" to "${newName}". ` +
      "Database renames can break downstream connection references; perform an explicit manual cutover instead.",
  );

const isObject = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

const isReadablePostgresOrigin = (value: unknown): value is PostgresOrigin =>
  isObject(value) &&
  typeof value.scheme === "string" &&
  typeof value.host === "string" &&
  typeof value.port === "number" &&
  typeof value.user === "string" &&
  value.password !== undefined;

const hasReadableLogicalDatabaseProps = (
  value: PostgresLogicalDatabaseProps | undefined,
) => isObject(value) && isReadablePostgresOrigin(value.adminOrigin);

const appRolePrivilegesHash = (privileges: AppRolePrivilegeState | undefined) =>
  privileges?.hash;

const recordHashes = (files: readonly SqlFile[]) =>
  Object.fromEntries(files.map((file) => [file.id, file.hash]));

const readLogicalDatabaseSqlFiles = (input: {
  readonly importFiles?: ReadonlyArray<string>;
  readonly migrationsDir?: string;
  readonly rootDir: string;
}) =>
  Effect.gen(function* () {
    const migrations = input.migrationsDir
      ? yield* listSqlFiles(input.migrationsDir)
      : [];
    const imports = yield* Effect.all(
      [...(input.importFiles ?? [])]
        .sort()
        .map((filePath) => readSqlFile(input.rootDir, filePath)),
    );

    return {
      imports,
      migrations,
    };
  });

const logicalDatabaseNeedsUpdate = (input: {
  readonly appRoleName: string | undefined;
  readonly appRolePrivileges: AppRolePrivilegeState | undefined;
  readonly appRolePrivilegesVersion: number;
  readonly imports: Record<string, string>;
  readonly importsTable: string;
  readonly migrations: Record<string, string>;
  readonly migrationsTable: string;
  readonly output: PostgresLogicalDatabaseAttributes;
  readonly owner: PostgresLogicalDatabaseOwner;
  readonly ownershipTable: string;
}) =>
  input.output.appRoleName !== input.appRoleName ||
  input.output.appRolePrivilegesHash !==
    appRolePrivilegesHash(input.appRolePrivileges) ||
  input.output.appRolePrivilegesVersion !== input.appRolePrivilegesVersion ||
  input.output.migrationsTable !== input.migrationsTable ||
  input.output.importsTable !== input.importsTable ||
  input.output.ownershipTable !== input.ownershipTable ||
  !ownersEqual(input.output.owner, input.owner) ||
  input.appRolePrivileges?.ready === false ||
  !recordsEqual(input.migrations, input.output.migrationsHashes) ||
  !recordsEqual(input.imports, input.output.importHashes);

const readAppRolePrivilegesIfConfigured = (input: {
  readonly appRoleName: string | undefined;
  readonly databaseName: string;
  readonly excludedTableNames: readonly string[];
  readonly origin: PostgresOrigin;
}) =>
  input.appRoleName
    ? Effect.tryPromise(() =>
        readAppRolePrivileges({
          databaseName: input.databaseName,
          excludedTableNames: input.excludedTableNames,
          origin: input.origin,
          roleName: input.appRoleName!,
        }),
      )
    : Effect.succeed(undefined);

const diffExistingDatabase = (input: {
  readonly appRoleName: string | undefined;
  readonly appRolePrivilegesVersion: number;
  readonly imports: Record<string, string>;
  readonly importsTable: string;
  readonly migrations: Record<string, string>;
  readonly migrationsTable: string;
  readonly output: PostgresLogicalDatabaseAttributes;
  readonly owner: PostgresLogicalDatabaseOwner;
  readonly ownershipTable: string;
  readonly props: PostgresLogicalDatabaseProps;
}) =>
  Effect.gen(function* () {
    const exists = yield* Effect.tryPromise(() =>
      databaseExists(input.props.adminOrigin, input.output.name),
    );
    if (!exists) return { action: "update" } as const;

    const appRolePrivileges = yield* readAppRolePrivilegesIfConfigured({
      appRoleName: input.appRoleName,
      databaseName: input.output.name,
      excludedTableNames: excludedAppRoleTableNames(
        input.migrationsTable,
        input.importsTable,
        input.ownershipTable,
      ),
      origin: input.props.adminOrigin,
    });

    return logicalDatabaseNeedsUpdate({
      appRoleName: input.appRoleName,
      appRolePrivileges,
      appRolePrivilegesVersion: input.appRolePrivilegesVersion,
      imports: input.imports,
      importsTable: input.importsTable,
      migrations: input.migrations,
      migrationsTable: input.migrationsTable,
      output: input.output,
      owner: input.owner,
      ownershipTable: input.ownershipTable,
    })
      ? ({ action: "update" } as const)
      : undefined;
  });

const readExistingDatabase = (input: {
  readonly id: string;
  readonly name: string;
  readonly olds: PostgresLogicalDatabaseProps;
  readonly output: PostgresLogicalDatabaseAttributes | undefined;
}) =>
  Effect.gen(function* () {
    const migrationsTable =
      input.olds.migrationsTable ??
      input.output?.migrationsTable ??
      DEFAULT_MIGRATIONS_TABLE;
    const importsTable =
      input.olds.importsTable ??
      input.output?.importsTable ??
      DEFAULT_IMPORTS_TABLE;
    const ownershipTable =
      input.output?.ownershipTable ?? DEFAULT_OWNERSHIP_TABLE;
    const owner = logicalDatabaseOwner(input.id);
    const databaseOwner = yield* Effect.tryPromise(() =>
      readDatabaseOwnership({
        databaseName: input.name,
        origin: input.olds.adminOrigin,
        ownerResourceType: POSTGRES_LOGICAL_DATABASE_RESOURCE_TYPE,
        tableName: ownershipTable,
      }),
    );
    const [migrationsHashes, importHashes] = yield* Effect.all(
      [
        Effect.tryPromise(() =>
          readTrackedSqlFileHashes({
            databaseName: input.name,
            origin: input.olds.adminOrigin,
            tableName: migrationsTable,
          }),
        ),
        Effect.tryPromise(() =>
          readTrackedSqlFileHashes({
            databaseName: input.name,
            origin: input.olds.adminOrigin,
            tableName: importsTable,
          }),
        ),
      ],
      { concurrency: 2 },
    );
    const appRoleName = input.olds.appRoleName ?? input.output?.appRoleName;
    const appRolePrivileges = yield* readAppRolePrivilegesIfConfigured({
      appRoleName,
      databaseName: input.name,
      excludedTableNames: excludedAppRoleTableNames(
        migrationsTable,
        importsTable,
        ownershipTable,
      ),
      origin: input.olds.adminOrigin,
    });
    const attributes = {
      appRoleName,
      appRolePrivilegesHash: appRolePrivilegesHash(appRolePrivileges),
      appRolePrivilegesVersion:
        input.olds.appRolePrivilegesVersion ??
        input.output?.appRolePrivilegesVersion ??
        DEFAULT_APP_ROLE_PRIVILEGES_VERSION,
      importHashes,
      importsTable,
      migrationsHashes,
      migrationsTable,
      name: input.name,
      owner,
      ownershipTable,
    } satisfies PostgresLogicalDatabaseAttributes;

    return ownersEqual(databaseOwner, owner) ? attributes : Unowned(attributes);
  });

const reconcileAppRolePrivileges = (input: {
  readonly appRoleName: string | undefined;
  readonly databaseName: string;
  readonly migrationsTable: string;
  readonly importsTable: string;
  readonly ownershipTable: string;
  readonly origin: PostgresOrigin;
  readonly session: { readonly note: (message: string) => Effect.Effect<void> };
}) =>
  input.appRoleName
    ? Effect.gen(function* () {
        yield* input.session.note(
          `Ensuring app role privileges for logical Postgres database "${input.databaseName}"...`,
        );
        yield* Effect.tryPromise(() =>
          ensureAppRolePrivileges({
            databaseName: input.databaseName,
            excludedTableNames: excludedAppRoleTableNames(
              input.migrationsTable,
              input.importsTable,
              input.ownershipTable,
            ),
            origin: input.origin,
            roleName: input.appRoleName!,
          }),
        );
        return yield* Effect.tryPromise(() =>
          readAppRolePrivileges({
            databaseName: input.databaseName,
            excludedTableNames: excludedAppRoleTableNames(
              input.migrationsTable,
              input.importsTable,
              input.ownershipTable,
            ),
            origin: input.origin,
            roleName: input.appRoleName!,
          }),
        );
      })
    : Effect.succeed(undefined);

export const PostgresLogicalDatabaseProvider = () =>
  Provider.effect(
    PostgresLogicalDatabase,
    Effect.gen(function* () {
      const rootDir = yield* Effect.sync(() => process.cwd());

      return {
        diff: Effect.fn(function* ({ id, news, output }) {
          if (!isResolved(news)) return undefined;
          if (!output) return undefined;

          const name = yield* createLogicalDatabaseName(id, news.name);
          if (output.name !== name) {
            return yield* Effect.fail(renameError(output.name, name));
          }

          const appRolePrivilegesVersion =
            news.appRolePrivilegesVersion ??
            DEFAULT_APP_ROLE_PRIVILEGES_VERSION;
          const migrationsTable =
            news.migrationsTable ??
            output.migrationsTable ??
            DEFAULT_MIGRATIONS_TABLE;
          const importsTable =
            news.importsTable ?? output.importsTable ?? DEFAULT_IMPORTS_TABLE;
          const ownershipTable =
            output.ownershipTable ?? DEFAULT_OWNERSHIP_TABLE;
          const owner = logicalDatabaseOwner(id);
          const { imports, migrations } = yield* readLogicalDatabaseSqlFiles({
            importFiles: news.importFiles,
            migrationsDir: news.migrationsDir,
            rootDir,
          });

          return yield* diffExistingDatabase({
            appRoleName: news.appRoleName,
            appRolePrivilegesVersion,
            imports: recordHashes(imports),
            importsTable,
            migrations: recordHashes(migrations),
            migrationsTable,
            output,
            owner,
            ownershipTable,
            props: news,
          });
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          if (!hasReadableLogicalDatabaseProps(olds)) return undefined;

          const name =
            output?.name ?? (yield* createLogicalDatabaseName(id, olds.name));
          const exists = yield* Effect.tryPromise(() =>
            databaseExists(olds.adminOrigin, name),
          );
          if (!exists) return undefined;

          return yield* readExistingDatabase({
            id,
            name,
            olds,
            output,
          });
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createLogicalDatabaseName(id, news.name);
          if (output?.name && output.name !== name) {
            return yield* Effect.fail(renameError(output.name, name));
          }

          const appRolePrivilegesVersion =
            news.appRolePrivilegesVersion ??
            DEFAULT_APP_ROLE_PRIVILEGES_VERSION;
          const migrationsTable =
            news.migrationsTable ??
            output?.migrationsTable ??
            DEFAULT_MIGRATIONS_TABLE;
          const importsTable =
            news.importsTable ?? output?.importsTable ?? DEFAULT_IMPORTS_TABLE;
          const ownershipTable =
            output?.ownershipTable ?? DEFAULT_OWNERSHIP_TABLE;
          const owner = logicalDatabaseOwner(id);
          const { imports, migrations } = yield* readLogicalDatabaseSqlFiles({
            importFiles: news.importFiles,
            migrationsDir: news.migrationsDir,
            rootDir,
          });

          yield* session.note(
            `Ensuring logical Postgres database "${name}"...`,
          );
          yield* Effect.tryPromise(() =>
            ensureDatabase(news.adminOrigin, name),
          );

          yield* session.note(
            `Claiming logical Postgres database "${name}"...`,
          );
          yield* Effect.tryPromise(() =>
            ensureDatabaseOwnership({
              databaseName: name,
              origin: news.adminOrigin,
              owner,
              tableName: ownershipTable,
            }),
          );

          yield* session.note(
            `Applying migrations for logical Postgres database "${name}"...`,
          );
          yield* Effect.tryPromise(() =>
            applyTrackedSqlFiles({
              changedFileAction: "reject",
              databaseName: name,
              files: migrations,
              origin: news.adminOrigin,
              tableName: migrationsTable,
            }),
          );

          yield* session.note(
            `Applying imports for logical Postgres database "${name}"...`,
          );
          yield* Effect.tryPromise(() =>
            applyTrackedSqlFiles({
              changedFileAction: "reapply",
              databaseName: name,
              files: imports,
              origin: news.adminOrigin,
              tableName: importsTable,
            }),
          );

          const appRoleName = news.appRoleName;
          const appRolePrivileges = yield* reconcileAppRolePrivileges({
            appRoleName,
            databaseName: name,
            importsTable,
            migrationsTable,
            origin: news.adminOrigin,
            ownershipTable,
            session,
          });

          return {
            appRoleName,
            appRolePrivilegesHash: appRolePrivilegesHash(appRolePrivileges),
            appRolePrivilegesVersion,
            importHashes: recordHashes(imports),
            importsTable,
            migrationsHashes: recordHashes(migrations),
            migrationsTable,
            name,
            owner,
            ownershipTable,
          } satisfies PostgresLogicalDatabaseAttributes;
        }),

        delete: Effect.fn(function* ({ olds, output, session }) {
          yield* session.note(
            `Dropping logical Postgres database "${output.name}"...`,
          );
          yield* Effect.tryPromise(() =>
            dropDatabase(olds.adminOrigin, output.name),
          );
        }),
      };
    }),
  );
