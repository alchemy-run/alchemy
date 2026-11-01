import {
  diffMigrations,
  migrationAttributesOf,
  migrationsAttrs,
  migrationsInputOf,
  stampedOf,
  type MigrationAttributes,
  type MigrationsInput,
} from "@alchemy.run/sql/Migrations";
import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  generatedIdentifier,
  instanceBusyRetry,
  isGeneratedIdentifier,
  listOwnedInstances,
  SETTLE_TIMEOUT,
  type SqlServerScope,
} from "./internal.ts";
import { runDatabaseMigrations } from "./Migrations.ts";

export interface DatabaseProps {
  /** Id of the instance holding the database. Changing it replaces the database. */
  instanceId: string;
  /**
   * Name of the database. Changing it replaces the database, since the API has no
   * database update.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * User that owns the database, usually a `Stackit.SQLServerFlex.User`'s `userName`.
   * The API can't move ownership, and the only other way to a new owner is a new, empty
   * database, so a deploy that names another owner fails with `DatabaseOwnerChanged` and
   * leaves the database as it is. Set `replaceOnOwnerChange` to replace it instead.
   */
  owner: string;
  /**
   * Replace the database, which deletes its data, when `owner` changes. This includes a
   * replacement of the owning `Stackit.SQLServerFlex.User`, as the new name isn't known
   * until it is created: any change to its `roles` or `defaultDatabase` does that, even
   * under an explicit `userName`.
   *
   * @default false
   */
  replaceOnOwnerChange?: boolean;
  /**
   * Collation of the database, one of the `collation_name`s `listCollations` lists in
   * the API, e.g. `SQL_Latin1_General_CP1_CI_AS`. Changing it replaces the database;
   * removing it changes nothing.
   *
   * @default the API's default
   */
  collation?: string;
  /**
   * Compatibility level, one of those `listCompatibilities` lists in the API, e.g.
   * `160`. Changing it replaces the database; removing it changes nothing.
   *
   * @default the API's default
   */
  compatibility?: number;
  /** Project that owns the instance. Changing it replaces the database. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the database. @default the profile's region */
  region?: string;
  /**
   * SQL migrations to apply on deploy, once the database exists. Accepts a directory
   * path, a `{ dir, table }` object, or a `Drizzle.Schema` output. Only pending
   * migrations run; editing or removing an applied file fails the deploy.
   *
   * Files are T-SQL, and may separate batches with `GO` lines. Each file runs in one
   * transaction, so a statement SQL Server refuses inside a transaction, such as
   * `ALTER DATABASE`, fails the migration.
   *
   * Bookkeeping lives in Alchemy's `__alchemy_migrations` table. A database migrated
   * earlier by Prisma is adopted by a one-way conversion on first deploy.
   *
   * They run over a direct connection from the deploying machine, so its public IP
   * has to be in the instance's `acl`. Alchemy doesn't open the ACL for you. Install
   * `mssql` to use them.
   */
  migrations?: MigrationsInput;
  /** User that `migrations` log in as. It owns the tables they create. */
  migrationsUser?: string;
  /** Password of `migrationsUser`, usually a `Stackit.SQLServerFlex.User`'s `password`. */
  migrationsPassword?: string | Redacted.Redacted<string> | undefined;
}

export interface DatabaseAttributes extends MigrationAttributes {
  /** STACKIT database id. */
  databaseId: number;
  /** Id of the instance holding the database. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Name of the database, its identity in the API. */
  name: string;
  /** User that owns the database. */
  owner: string;
  /** Collation of the database. */
  collationName: string;
  /** Compatibility level of the database. */
  compatibilityLevel: number;
}

export type Database = Resource<
  "Stackit.SQLServerFlex.Database",
  DatabaseProps,
  DatabaseAttributes,
  never,
  Providers
>;

/**
 * A logical database on a `Stackit.SQLServerFlex.Instance`.
 *
 * The API has no database update, so changing the name, collation or compatibility
 * level replaces the database, and a replacement starts empty: back up what you need
 * first. Only `migrations` update in place.
 *
 * A new owner doesn't replace the database unless `replaceOnOwnerChange` asks for it:
 * the deploy fails with `DatabaseOwnerChanged`. Give the owning user an explicit
 * `userName`, so that replacing the user, which a change to its roles does, keeps the
 * owner's name and the database.
 *
 * The API has no labels for databases, so a database found by an explicit name without
 * state is reported as unowned, and only taken over with `--adopt`.
 *
 * ### Creating a Database
 * **Example:** A database owned by a user
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const user = yield* Stackit.SQLServerFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 *   roles: ["##STACKIT_LoginManager##", "##STACKIT_DatabaseManager##"],
 * });
 * const database = yield* Stackit.SQLServerFlex.Database("AppDatabase", {
 *   instanceId: instance.instanceId,
 *   name: "orders",
 *   owner: user.userName,
 * });
 * ```
 *
 * **Example:** A chosen collation and compatibility level
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const user = yield* Stackit.SQLServerFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 *   roles: ["##STACKIT_LoginManager##", "##STACKIT_DatabaseManager##"],
 * });
 * const database = yield* Stackit.SQLServerFlex.Database("AppDatabase", {
 *   instanceId: instance.instanceId,
 *   owner: user.userName,
 *   collation: "SQL_Latin1_General_CP1_CI_AS",
 *   compatibility: 160,
 * });
 * ```
 *
 * ### Migrations
 * **Example:** Apply migrations from a directory as the owner
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   // The machine running `alchemy deploy` has to be in here.
 *   acl: ["203.0.113.7/32"],
 * });
 * const user = yield* Stackit.SQLServerFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 *   roles: ["##STACKIT_LoginManager##", "##STACKIT_DatabaseManager##"],
 * });
 * const database = yield* Stackit.SQLServerFlex.Database("AppDatabase", {
 *   instanceId: instance.instanceId,
 *   owner: user.userName,
 *   migrations: "./migrations",
 *   migrationsUser: user.userName,
 *   migrationsPassword: user.password,
 * });
 * ```
 *
 * Migrations run over a direct `mssql` connection from the deploying machine: SQL
 * Server Flex has no SQL API. The connection is encrypted and checks the server's
 * certificate, and the machine's public IP has to be in the instance's `acl`, which
 * Alchemy doesn't open for you. An instance with `accessScope: "SNA"` can't be reached
 * from outside, so migrations fail on it. Install `mssql`.
 *
 * **Example:** Log in with your own credentials
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Redacted from "effect/Redacted";
 *
 * const instance = yield* Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const owner = yield* Stackit.SQLServerFlex.User("Owner", {
 *   instanceId: instance.instanceId,
 *   roles: ["##STACKIT_LoginManager##", "##STACKIT_DatabaseManager##"],
 * });
 * const database = yield* Stackit.SQLServerFlex.Database("AppDatabase", {
 *   instanceId: instance.instanceId,
 *   owner: owner.userName,
 *   migrations: { dir: "./migrations", table: "schema_history" },
 *   migrationsUser: "app_migrator",
 *   migrationsPassword: Redacted.make("a-password-you-manage"),
 * });
 * ```
 *
 * ### Connecting from a Host
 * **Example:** Resolve connection settings with `Connect`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const user = yield* Stackit.SQLServerFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 *   roles: ["##STACKIT_LoginManager##", "##STACKIT_DatabaseManager##"],
 * });
 * const database = yield* Stackit.SQLServerFlex.Database("AppDatabase", {
 *   instanceId: instance.instanceId,
 *   owner: user.userName,
 * });
 * // Inside a Worker or Function's init phase:
 * const connect = yield* Stackit.SQLServerFlex.Connect(database, user);
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Opting in to a new, empty database for a new owner
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.SQLServerFlex.Instance("Db", {
 *   flavorId: "4.16-Single",
 *   version: "2022",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const newOwner = yield* Stackit.SQLServerFlex.User("NewOwner", {
 *   instanceId: instance.instanceId,
 *   roles: ["##STACKIT_LoginManager##", "##STACKIT_DatabaseManager##"],
 * });
 * // The old database and its data are deleted. An explicit `name` makes the
 * // replacement delete the old database before it creates the new one.
 * const database = yield* Stackit.SQLServerFlex.Database("AppDatabase", {
 *   instanceId: instance.instanceId,
 *   name: "orders",
 *   owner: newOwner.userName,
 *   replaceOnOwnerChange: true,
 * });
 * ```
 *
 * @resource
 * @product STACKIT SQL Server Flex
 * @category SQLServerFlex
 */
export const Database = Resource<Database>("Stackit.SQLServerFlex.Database");

/**
 * A deploy names another owner than the database has. The API can't move ownership, and
 * replacing the database would delete its data, which takes `replaceOnOwnerChange`.
 */
export class DatabaseOwnerChanged extends Data.TaggedError(
  "Stackit.SQLServerFlex.DatabaseOwnerChanged",
)<{
  readonly database: string;
  readonly owner: string;
  readonly requestedOwner: string;
  readonly message: string;
}> {}

const getDatabaseOrUndefined = (scope: SqlServerScope, instanceId: string, databaseName: string) =>
  sqlserver
    .getDatabase({ ...scope, instanceId, databaseName })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const listDatabaseSummaries = (scope: SqlServerScope, instanceId: string) =>
  collectPages(
    (page) => sqlserver.listDatabases({ ...scope, instanceId, page }),
    (response) => response.databases,
  );

const toAttrs = (
  scope: SqlServerScope,
  instanceId: string,
  database: sqlserver.GetDatabaseResponse,
  migrations: Partial<MigrationAttributes> | undefined,
): DatabaseAttributes => ({
  databaseId: database.id,
  instanceId,
  projectId: scope.projectId,
  region: scope.region,
  name: database.name,
  owner: database.owner,
  collationName: database.collationName,
  compatibilityLevel: database.compatibilityLevel,
  ...migrationAttributesOf(migrations),
});

/** SQL Server compares collation and login names without regard to case. */
const sameCollation = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameLogin = sameCollation;

export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    stables: ["databaseId", "instanceId", "projectId", "region", "name"],
    nuke: { dependsOn: ["Stackit.SQLServerFlex.Instance"] },

    // Deleting an instance takes its databases with it, so nuke only needs the ones
    // Alchemy named. That also keeps system databases out, which no source lists.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const instances = yield* listOwnedInstances(scope);
      const databases: DatabaseAttributes[] = [];
      for (const instance of instances) {
        const summaries = yield* listDatabaseSummaries(scope, instance.id).pipe(
          // The instance may be deleted mid-listing.
          Effect.catchTag("NotFound", () => Effect.succeed([])),
        );
        for (const summary of summaries) {
          if (!isGeneratedIdentifier(summary.name)) continue;
          const database = yield* getDatabaseOrUndefined(scope, instance.id, summary.name);
          if (database === undefined) continue;
          databases.push(toAttrs(scope, instance.id, database, undefined));
        }
      }
      return databases;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved id can resolve to the instance the database already sits on, and
      // an explicit name can't exist twice on one instance: delete the old one first.
      // A generated name carries the generation, so it never collides. An unresolved
      // owner only replaces on request: it is what a replaced user looks like, and that
      // often keeps its name. Reconcile compares it once it is resolved.
      const replaceOnOwnerChange = rawProp<DatabaseProps>(news, "replaceOnOwnerChange") === true;
      if (
        hasUnresolvedTrigger<DatabaseProps>(news, [
          "instanceId",
          "projectId",
          "region",
          "name",
          "collation",
          "compatibility",
        ]) ||
        (replaceOnOwnerChange && hasUnresolvedTrigger<DatabaseProps>(news, ["owner"]))
      ) {
        return {
          action: "replace",
          deleteFirst: rawProp<DatabaseProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<DatabaseProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      // Elsewhere, or under another name, the old database can't collide with the new.
      if (
        resolved.instanceId !== output.instanceId ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region ||
        (resolved.name !== undefined && resolved.name !== output.name)
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Compared with the props last deployed where there are any: the API doesn't
      // promise to answer with an owner or setting exactly as it was asked for, and an
      // unchanged deploy must not replace, and so empty, the database.
      if (
        (replaceOnOwnerChange && resolved.owner !== (olds?.owner ?? output.owner)) ||
        (resolved.collation !== undefined &&
          !sameCollation(resolved.collation, olds?.collation ?? output.collationName)) ||
        (resolved.compatibility !== undefined &&
          resolved.compatibility !== (olds?.compatibility ?? output.compatibilityLevel))
      ) {
        return { action: "replace", deleteFirst: resolved.name !== undefined } as const;
      }
      if (!isResolved(news)) return undefined;
      // Pending files or a table move update in place, never replace.
      if (yield* diffMigrations({ news, output })) return { action: "update" } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      const name = output?.name ?? olds?.name ?? (yield* generatedIdentifier(id));
      // A missing instance answers `NotFound` too: the database is gone with it.
      const found = yield* getDatabaseOrUndefined(scope, instanceId, name);
      if (found === undefined) return undefined;
      const attrs = toAttrs(scope, instanceId, found, output);
      if (output?.databaseId === found.id) return attrs;
      // No labels: a generated name carries this generation's id, so it is ours.
      // An explicit name proves nothing, unless it is the generation being replaced.
      // A database id is only unique on its instance, so the instance has to match.
      const isPrevious =
        previous?.databaseId === found.id &&
        previous.instanceId === instanceId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return olds?.name === undefined || isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const instanceId = news.instanceId;
      // Only this generation's generated name proves a database is ours. A name kept
      // from `output` after the prop was removed can be someone else's.
      const generatedName = yield* generatedIdentifier(id);
      const name = news.name ?? output?.name ?? generatedName;
      const generated = name === generatedName;
      const resource = `STACKIT SQL Server Flex database ${name}`;

      // 1. Observe — the name is the API's identity. `output` only speaks for it while
      // it names the same database on the desired instance. Otherwise only a generated
      // name can be claimed (a crashed create).
      const known =
        output?.instanceId === instanceId &&
        output.projectId === scope.projectId &&
        output.region === scope.region &&
        output.name === name;
      let current =
        known || generated ? yield* getDatabaseOrUndefined(scope, instanceId, name) : undefined;

      // The owner can't be moved, and a replacement would delete the data, so a real change
      // stops here. The same owner as last time is no change, however the API spells it.
      if (
        current !== undefined &&
        news.owner !== olds?.owner &&
        !sameLogin(current.owner, news.owner)
      ) {
        return yield* new DatabaseOwnerChanged({
          database: name,
          owner: current.owner,
          requestedOwner: news.owner,
          message: `${resource} is owned by ${current.owner}, and the API can't move it to ${news.owner}. Give the owning user an explicit userName so that replacing it keeps the owner's name, or set replaceOnOwnerChange to replace the database, which deletes its data.`,
        });
      }

      // 2. Ensure — an explicit name another database holds is someone else's, and the
      // create fails on it.
      if (current === undefined) {
        yield* sqlserver
          .createDatabase({
            ...scope,
            instanceId,
            name,
            owner: news.owner,
            ...(news.collation !== undefined ? { collation: news.collation } : {}),
            ...(news.compatibility !== undefined ? { compatibility: news.compatibility } : {}),
          })
          .pipe(Effect.retry(instanceBusyRetry));
        // A database has no state to wait on: the create is done once it is visible.
        const visible = yield* waitFor({
          resource,
          read: getDatabaseOrUndefined(scope, instanceId, name),
          ready: (database) => database !== undefined,
          state: (database) => (database === undefined ? "not visible yet" : database.name),
          timeout: SETTLE_TIMEOUT,
        });
        // `ready` only passes a database.
        current = visible as sqlserver.GetDatabaseResponse;
      }

      // 3. Sync — nothing on a database can change but its schema. Migrations last, once
      // the database is ready.
      const migrationsInput = migrationsInputOf(news);
      const run = migrationsInput
        ? yield* runDatabaseMigrations({
            scope,
            instanceId,
            database: name,
            input: migrationsInput,
            stamped: stampedOf(output),
            user: news.migrationsUser,
            password: news.migrationsPassword,
          })
        : undefined;

      // 4. Return
      return toAttrs(
        scope,
        instanceId,
        current,
        migrationsAttrs({ input: migrationsInput, run, output }),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { instanceId, name } = output;
      yield* sqlserver.deleteDatabase({ ...scope, instanceId, databaseName: name }).pipe(
        Effect.retry(instanceBusyRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitUntilGone({
        resource: `STACKIT SQL Server Flex database ${name}`,
        read: getDatabaseOrUndefined(scope, instanceId, name),
        state: (database) => database.name,
        timeout: SETTLE_TIMEOUT,
      });
    }),
  });
