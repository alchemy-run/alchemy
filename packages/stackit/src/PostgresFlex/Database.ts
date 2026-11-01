import {
  diffMigrations,
  migrationAttributesOf,
  migrationsAttrs,
  migrationsInputOf,
  stampedOf,
  type MigrationAttributes,
  type MigrationsInput,
} from "@alchemy.run/sql/Migrations";
import * as postgres from "@distilled.cloud/stackit/postgres_flex";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  deleteBlockedRetry,
  generatedIdentifier,
  instanceLockedRetry,
  listOwnedInstances,
  SETTLE_TIMEOUT,
  type PostgresScope,
} from "./internal.ts";
import { runDatabaseMigrations } from "./Migrations.ts";

/** Databases of an instance that aren't anyone's to delete. */
const SYSTEM_DATABASES = new Set(["postgres", "stackit", "template0", "template1"]);

export interface DatabaseProps {
  /** Id of the instance holding the database. Changing it replaces the database. */
  instanceId: string;
  /**
   * Name of the database: 1-63 characters, starting with a lowercase letter or
   * underscore, then lowercase letters, numbers, underscores or hyphens, and not
   * ending with a hyphen. Updates in place.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /** User that owns the database, usually a `Stackit.PostgresFlex.User`'s `userName`. Updates in place. */
  owner: string;
  /** Project that owns the instance. Changing it replaces the database. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the database. @default the profile's region */
  region?: string;
  /**
   * SQL migrations to apply on deploy, once the database exists. Accepts a directory
   * path, a `{ dir, table }` object, or a `Drizzle.Schema` output. Only pending
   * migrations run; editing or removing an applied file fails the deploy.
   *
   * Bookkeeping lives in Alchemy's `__alchemy_migrations` table. A database migrated
   * earlier by drizzle-kit or Prisma is adopted by a one-way conversion on first
   * deploy.
   *
   * They run over a direct connection from the deploying machine, so its public IP
   * has to be in the instance's `acl`. Alchemy doesn't open the ACL for you. Install
   * `pg` to use them.
   */
  migrations?: MigrationsInput;
  /** User that `migrations` log in as. It owns the tables they create. */
  migrationsUser?: string;
  /** Password of `migrationsUser`, usually a `Stackit.PostgresFlex.User`'s `password`. */
  migrationsPassword?: string | Redacted.Redacted<string> | undefined;
}

export interface DatabaseAttributes extends MigrationAttributes {
  /** STACKIT database id. Stable across updates. */
  databaseId: number;
  /** Id of the instance holding the database. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Name of the database. */
  name: string;
  /** User that owns the database. */
  owner: string;
}

export type Database = Resource<
  "Stackit.PostgresFlex.Database",
  DatabaseProps,
  DatabaseAttributes,
  never,
  Providers
>;

/**
 * A logical database on a `Stackit.PostgresFlex.Instance`.
 *
 * Name and owner update in place; moving the database to another instance replaces
 * it. The API has no labels for databases, so a database found by an explicit name
 * without state is reported as unowned, and only taken over with `--adopt`.
 *
 * ### Creating a Database
 * **Example:** A database owned by a user
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const user = yield* Stackit.PostgresFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 * });
 * const database = yield* Stackit.PostgresFlex.Database("AppDatabase", {
 *   instanceId: instance.instanceId,
 *   name: "orders",
 *   owner: user.userName,
 * });
 * ```
 *
 * ### Migrations
 * **Example:** Apply migrations from a directory as the owner
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   // The machine running `alchemy deploy` has to be in here.
 *   acl: ["203.0.113.7/32"],
 * });
 * const user = yield* Stackit.PostgresFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 * });
 * const database = yield* Stackit.PostgresFlex.Database("AppDatabase", {
 *   instanceId: instance.instanceId,
 *   owner: user.userName,
 *   migrations: "./migrations",
 *   migrationsUser: user.userName,
 *   migrationsPassword: user.password,
 * });
 * ```
 *
 * Migrations run over a direct `pg` connection from the deploying machine: PostgreSQL
 * Flex has no SQL API. Connections need TLS, and the machine's public IP has to be in
 * the instance's `acl`, which Alchemy doesn't open for you. An instance with
 * `accessScope: "SNA"` can't be reached from outside, so migrations fail on it. Install
 * `pg`.
 *
 * **Example:** Log in with your own credentials
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Redacted from "effect/Redacted";
 *
 * const instance = yield* Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const database = yield* Stackit.PostgresFlex.Database("AppDatabase", {
 *   instanceId: instance.instanceId,
 *   owner: "app_owner",
 *   migrations: { dir: "./migrations", table: "schema_history" },
 *   migrationsUser: "app_owner",
 *   migrationsPassword: Redacted.make("a-password-you-manage"),
 * });
 * ```
 *
 * ### Connecting from a Host
 * **Example:** Resolve connection settings with `Connect`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.PostgresFlex.Instance("Db", {
 *   flavorId: "2.4",
 *   version: "17",
 *   storage: { class: "premium-perf2-stackit", size: 5 },
 *   backupSchedule: "0 2 * * *",
 *   retentionDays: 32,
 *   acl: ["203.0.113.7/32"],
 * });
 * const user = yield* Stackit.PostgresFlex.User("AppUser", {
 *   instanceId: instance.instanceId,
 * });
 * const database = yield* Stackit.PostgresFlex.Database("AppDatabase", {
 *   instanceId: instance.instanceId,
 *   owner: user.userName,
 * });
 * // Inside a Worker or Function's init phase:
 * const connect = yield* Stackit.PostgresFlex.Connect(database, user);
 * ```
 *
 * @resource
 * @product STACKIT PostgreSQL Flex
 * @category PostgresFlex
 */
export const Database = Resource<Database>("Stackit.PostgresFlex.Database");

const getDatabaseOrUndefined = (scope: PostgresScope, instanceId: string, databaseId: number) =>
  postgres
    .getDatabase({ ...scope, instanceId, databaseId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const listDatabaseSummaries = (scope: PostgresScope, instanceId: string) =>
  collectPages(
    (page) => postgres.listDatabases({ ...scope, instanceId, page }),
    (response) => response.databases,
  );

const findDatabaseByName = (scope: PostgresScope, instanceId: string, name: string) =>
  listDatabaseSummaries(scope, instanceId).pipe(
    Effect.map((databases) => databases.find((database) => database.name === name)),
  );

const toAttrs = (
  scope: PostgresScope,
  instanceId: string,
  database: Pick<postgres.GetDatabaseResponse, "id" | "name" | "owner">,
  migrations: Partial<MigrationAttributes> | undefined,
): DatabaseAttributes => ({
  databaseId: database.id,
  instanceId,
  projectId: scope.projectId,
  region: scope.region,
  name: database.name,
  owner: database.owner,
  ...migrationAttributesOf(migrations),
});

export const DatabaseProvider = () =>
  Provider.succeed(Database, {
    stables: ["databaseId", "instanceId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.PostgresFlex.Instance"] },

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
          if (SYSTEM_DATABASES.has(summary.name)) continue;
          databases.push(toAttrs(scope, instance.id, summary, undefined));
        }
      }
      return databases;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved id can resolve to the instance the database already sits on,
      // and an explicit name can't exist twice on one instance: delete the old one
      // first. A generated name carries the generation, so it never collides.
      if (hasUnresolvedTrigger<DatabaseProps>(news, ["instanceId", "projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<DatabaseProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<DatabaseProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (
        resolved.instanceId !== output.instanceId ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
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
      if (output?.databaseId !== undefined) {
        const byId = yield* getDatabaseOrUndefined(scope, instanceId, output.databaseId);
        if (byId !== undefined) return toAttrs(scope, instanceId, byId, output);
      }
      const name = output?.name ?? olds?.name ?? (yield* generatedIdentifier(id));
      const found = yield* findDatabaseByName(scope, instanceId, name).pipe(
        // The instance is gone, and the database with it.
        Effect.catchTag("NotFound", () => Effect.undefined),
      );
      if (found === undefined) return undefined;
      const attrs = toAttrs(scope, instanceId, found, output);
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

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const instanceId = news.instanceId;
      // Only this generation's generated name proves a database is ours. A name
      // kept from `output` after the prop was removed can be someone else's.
      const generatedName = yield* generatedIdentifier(id);
      const name = news.name ?? output?.name ?? generatedName;
      const generated = name === generatedName;
      const resource = `STACKIT PostgreSQL Flex database ${name}`;

      // 1. Observe — by cached id, while it still names a database on the desired
      // instance, then by a generated name (a crashed create).
      let databaseId: number | undefined;
      if (
        output?.instanceId === instanceId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
      ) {
        const byId = yield* getDatabaseOrUndefined(scope, instanceId, output.databaseId);
        databaseId = byId?.id;
      }
      if (databaseId === undefined && generated) {
        const byName = yield* findDatabaseByName(scope, instanceId, name);
        databaseId = byName?.id;
      }

      // 2. Ensure — a Conflict on an explicit name is someone else's database, and
      // fails. On a generated name it is a race we lost to ourselves.
      if (databaseId === undefined) {
        const created = yield* postgres
          .createDatabase({ ...scope, instanceId, name, owner: news.owner })
          .pipe(
            Effect.retry(instanceLockedRetry),
            Effect.catchTag("Conflict", (error) =>
              generated
                ? findDatabaseByName(scope, instanceId, name).pipe(
                    Effect.flatMap((found) =>
                      found === undefined ? Effect.fail(error) : Effect.succeed({ id: found.id }),
                    ),
                  )
                : Effect.fail(error),
            ),
          );
        databaseId = created.id;
      }
      const liveId = databaseId;
      const read = getDatabaseOrUndefined(scope, instanceId, liveId);
      const settle = (applied: (database: postgres.GetDatabaseResponse) => boolean) =>
        waitFor({
          resource,
          read,
          ready: (database) => database !== undefined && applied(database),
          state: (database) => (database === undefined ? "not visible yet" : database.name),
          timeout: SETTLE_TIMEOUT,
        }).pipe(
          // `ready` only passes a database.
          Effect.map((database) => database as postgres.GetDatabaseResponse),
        );
      // A database has no state to wait on: the create is done once it is visible.
      let current = yield* settle(() => true);

      // 3. Sync — observed name and owner against the desired ones.
      const delta = {
        ...(current.name !== name ? { name } : {}),
        ...(current.owner !== news.owner ? { owner: news.owner } : {}),
      };
      if (Object.keys(delta).length > 0) {
        yield* postgres
          .partialUpdateDatabase({ ...scope, instanceId, databaseId: liveId, ...delta })
          .pipe(Effect.retry(instanceLockedRetry));
        current = yield* settle(
          (database) => database.name === name && database.owner === news.owner,
        );
      }

      // Migrations last, once the database is ready and every other aspect is synced.
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
      const { instanceId, databaseId } = output;
      yield* postgres.deleteDatabase({ ...scope, instanceId, databaseId }).pipe(
        Effect.retry(deleteBlockedRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitUntilGone({
        resource: `STACKIT PostgreSQL Flex database ${output.name}`,
        read: getDatabaseOrUndefined(scope, instanceId, databaseId),
        state: (database) => database.name,
        timeout: SETTLE_TIMEOUT,
      });
    }),
  });
