import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Redacted from "effect/Redacted";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  PrismaClient,
  extractConnectionSecrets,
  isConflict,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import type { Project } from "./Project.ts";
import type { Providers } from "./Providers.ts";
import {
  isPrismaDevId,
  resolveProjectId,
  unresolvedProjectIdOf,
} from "./Refs.ts";
import type {
  Database as ApiDatabase,
  DatabaseSourceInput,
  PrismaSecretConnection,
} from "./Types.ts";

export interface DatabaseDev {
  /**
   * Local provider used by `alchemy dev`.
   *
   * @default "@prisma/dev"
   */
  provider?: "@prisma/dev";
  /**
   * Stable local server name.
   */
  name?: string;
  /**
   * Local storage mode for the database server.
   *
   * @default "stateful"
   */
  persistenceMode?: "stateless" | "stateful";
  /**
   * HTTP control port for the local server.
   */
  port?: number;
  /**
   * Direct Postgres port for the local database.
   */
  databasePort?: number;
  /**
   * Direct Postgres port for the local shadow database.
   */
  shadowDatabasePort?: number;
  /**
   * Enable local provider debug logging.
   *
   * @default false
   */
  debug?: boolean;
  /**
   * Connection timeout in milliseconds for pending database clients.
   */
  databaseConnectTimeoutMillis?: number;
  /**
   * Idle timeout in milliseconds for active database clients.
   */
  databaseIdleTimeoutMillis?: number;
  /**
   * Connection timeout in milliseconds for pending shadow database clients.
   */
  shadowDatabaseConnectTimeoutMillis?: number;
  /**
   * Idle timeout in milliseconds for active shadow database clients.
   */
  shadowDatabaseIdleTimeoutMillis?: number;
  /**
   * Optional shell command to run after the local database is ready.
   */
  migrate?: string;
  /**
   * Working directory for the migration command.
   */
  migrateCwd?: string;
}

export interface DatabaseProps {
  /**
   * Project ID or `project.projectId` output that owns this database.
   */
  project: string | Project;
  /**
   * Database display name. Prisma will choose a default when omitted.
   */
  name?: string;
  /**
   * Region for the database.
   *
   * @default "us-east-1"
   */
  region?: string;
  /**
   * Whether this database should be the project's default database.
   *
   * @default false
   */
  isDefault?: boolean;
  /**
   * Optional source database/backup descriptor for clone or restore creation.
   */
  source?: DatabaseSourceInput;
  /**
   * Branch ID to attach the database to. Mutually exclusive with branchGitName.
   */
  branchId?: string | null;
  /**
   * Branch git name to attach the database to. Mutually exclusive with branchId.
   */
  branchGitName?: string | null;
  /**
   * Local database settings for `alchemy dev`. Set to `false` to keep only
   * placeholder IDs.
   */
  dev?: false | DatabaseDev;
}

export interface Database extends Resource<
  "Prisma.Database",
  DatabaseProps,
  {
    /**
     * Prisma database ID.
     */
    databaseId: string;
    /**
     * Prisma database display name.
     */
    databaseName: string;
    /**
     * Project ID that owns the database.
     */
    projectId: string;
    /**
     * Current Prisma database status.
     */
    status: string;
    /**
     * Prisma Postgres region ID, when available.
     */
    region: string | null;
    /**
     * Whether this is the project's default database.
     */
    isDefault: boolean;
    /**
     * Branch ID attached to the database, or null when unassigned.
     */
    branchId: string | null;
    /**
     * Default connection ID for the database.
     */
    defaultConnectionId: string | null;
    /**
     * ISO timestamp when the database was created.
     */
    createdAt: string;
    /**
     * Legacy connection string returned on create, redacted in state.
     */
    connectionString: Redacted.Redacted<string> | undefined;
    /**
     * Direct Postgres connection string, redacted in state.
     */
    directConnectionString: Redacted.Redacted<string> | undefined;
    /**
     * Pooled Postgres connection string, redacted in state.
     */
    pooledConnectionString: Redacted.Redacted<string> | undefined;
    /**
     * Accelerate connection string, redacted in state.
     */
    accelerateConnectionString: Redacted.Redacted<string> | undefined;
    /**
     * Direct database host, when returned by Prisma.
     */
    host: string | null | undefined;
    /**
     * Direct database username, when returned by Prisma.
     */
    user: string | null | undefined;
    /**
     * Direct database password, redacted in state.
     */
    password: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * A Prisma Postgres database inside a Prisma project.
 *
 * @section Creating a Database
 * @example Database in a project
 * ```typescript
 * const project = yield* Prisma.Project("app", { createDatabase: false });
 * const database = yield* Prisma.Database("db", {
 *   project: project.projectId,
 *   name: "production",
 *   region: "us-east-1",
 * });
 * ```
 */
export const Database = Resource<Database>("Prisma.Database");

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const findDatabase = (
  client: PrismaManagementClient,
  projectId: string,
  name: string | undefined,
) =>
  name === undefined
    ? Effect.succeed(undefined)
    : client
        .listProjectDatabases(projectId, { limit: 100 })
        .pipe(
          Effect.map((databases) =>
            databases.find((d: ApiDatabase) => d.name === name),
          ),
        );

const attrsFrom = (
  database: ApiDatabase,
  secrets: PrismaSecretConnection,
): Database["Attributes"] => ({
  databaseId: database.id,
  databaseName: database.name,
  projectId: database.project.id,
  status: database.status,
  region: database.region?.id ?? null,
  isDefault: database.isDefault,
  branchId: database.branchId,
  defaultConnectionId: database.defaultConnectionId,
  createdAt: database.createdAt,
  connectionString: secrets.connectionString,
  directConnectionString: secrets.directConnectionString,
  pooledConnectionString: secrets.pooledConnectionString,
  accelerateConnectionString: secrets.accelerateConnectionString,
  host: secrets.host,
  user: secrets.user,
  password: secrets.password,
});

const branchNeedsSync = Effect.fn(function* (
  client: PrismaManagementClient,
  projectId: string,
  database: ApiDatabase,
  props: DatabaseProps,
) {
  if (props.branchId !== undefined && !isPrismaDevId(props.branchId)) {
    return database.branchId !== props.branchId;
  }
  if (props.branchGitName === undefined) {
    return false;
  }
  if (props.branchGitName === null) {
    return database.branchId !== null;
  }
  const branch = yield* client
    .listBranches(projectId, { gitName: props.branchGitName, limit: 1 })
    .pipe(Effect.map((branches) => branches[0]));
  return branch === undefined || branch.id !== database.branchId;
});

const branchAttachment = (props: DatabaseProps) =>
  props.branchId !== undefined && !isPrismaDevId(props.branchId)
    ? {
        branchId: props.branchId,
        branchGitName: undefined,
      }
    : props.branchGitName !== undefined
      ? {
          branchId: undefined,
          branchGitName: props.branchGitName,
        }
      : {
          branchId: undefined,
          branchGitName: undefined,
        };

const validateDatabaseProps = (props: DatabaseProps) =>
  Effect.gen(function* () {
    if (props.branchId !== undefined && props.branchGitName !== undefined) {
      return yield* Effect.fail(
        new Error("branchId and branchGitName are mutually exclusive."),
      );
    }
  });

export const DatabaseProvider = () =>
  Provider.effect(
    Database,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["databaseId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (isPrismaDevId(output?.databaseId)) {
            return { action: "update" } as const;
          }
          const oldProjectId = unresolvedProjectIdOf(olds.project);
          const newProjectId = unresolvedProjectIdOf(news.project);
          if (oldProjectId === undefined || newProjectId === undefined) {
            return undefined;
          }
          if (
            newProjectId !== oldProjectId ||
            (news.region ?? "us-east-1") !==
              (olds.region ?? output?.region ?? "us-east-1") ||
            (news.isDefault ?? false) !== (olds.isDefault ?? false) ||
            !sameJson(news.source, olds.source)
          ) {
            return { action: "replace" } as const;
          }
          if (
            news.name !== olds.name ||
            news.branchId !== olds.branchId ||
            news.branchGitName !== olds.branchGitName
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const databaseId = isPrismaDevId(output?.databaseId)
            ? undefined
            : output?.databaseId;
          const database = databaseId
            ? yield* client
                .getDatabase(databaseId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* Effect.gen(function* () {
                const projectId = unresolvedProjectIdOf(olds.project);
                return projectId
                  ? yield* findDatabase(client, projectId, olds.name)
                  : undefined;
              });
          if (!database) return undefined;
          return attrsFrom(database, {
            connectionString: output?.connectionString,
            directConnectionString: output?.directConnectionString,
            pooledConnectionString: output?.pooledConnectionString,
            accelerateConnectionString: output?.accelerateConnectionString,
            host: output?.host,
            user: output?.user,
            password: output?.password,
          });
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          yield* validateDatabaseProps(news);
          const projectId = yield* resolveProjectId(news.project);
          const databaseId = isPrismaDevId(output?.databaseId)
            ? undefined
            : output?.databaseId;
          let database = databaseId
            ? yield* client
                .getDatabase(databaseId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* findDatabase(client, projectId, news.name);

          let secrets: PrismaSecretConnection = {};
          let createdDatabase = false;
          const attach = branchAttachment(news);
          if (!database) {
            const result = yield* client
              .createDatabase({
                projectId,
                name: news.name,
                region: news.region ?? "us-east-1",
                isDefault: news.isDefault ?? false,
                source: news.source,
                branchId: attach.branchId,
                branchGitName: attach.branchGitName,
              })
              .pipe(
                Effect.map((database) => ({
                  database,
                  secrets: extractConnectionSecrets(database.connections[0]),
                  created: true,
                })),
                Effect.catchIf(isConflict, () =>
                  news.name === undefined
                    ? Effect.fail(
                        new Error(
                          "Prisma database already exists but cannot be read because no name was provided",
                        ),
                      )
                    : findDatabase(client, projectId, news.name).pipe(
                        Effect.flatMap((database) =>
                          database
                            ? Effect.succeed({
                                database,
                                secrets: {},
                                created: false,
                              })
                            : Effect.fail(
                                new Error(
                                  `Prisma database '${news.name}' already exists but could not be read`,
                                ),
                              ),
                        ),
                      ),
                ),
              );
            database = result.database;
            secrets = result.secrets;
            createdDatabase = result.created;
          }

          const needsPatch = createdDatabase
            ? false
            : (news.name !== undefined && database.name !== news.name) ||
              (yield* branchNeedsSync(client, projectId, database, news));
          if (needsPatch) {
            database = yield* client.updateDatabase(database.id, {
              name: news.name,
              branchId: attach.branchId,
              branchGitName: attach.branchGitName,
            });
          }

          return attrsFrom(database, {
            connectionString:
              secrets.connectionString ?? output?.connectionString,
            directConnectionString:
              secrets.directConnectionString ?? output?.directConnectionString,
            pooledConnectionString:
              secrets.pooledConnectionString ?? output?.pooledConnectionString,
            accelerateConnectionString:
              secrets.accelerateConnectionString ??
              output?.accelerateConnectionString,
            host: secrets.host ?? output?.host,
            user: secrets.user ?? output?.user,
            password: secrets.password ?? output?.password,
          });
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.databaseId)) return;
          yield* client
            .deleteDatabase(output.databaseId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      };
    }),
  );
