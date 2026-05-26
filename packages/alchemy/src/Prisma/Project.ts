import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Redacted from "effect/Redacted";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  PrismaClient,
  extractConnectionSecrets,
  isConflict,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import { destroyComputeProject } from "./ComputeLifecycle.ts";
import { isPrismaDevId } from "./Refs.ts";
import type { Providers } from "./Providers.ts";
import type {
  Database,
  PrismaSecretConnection,
  Project as ApiProject,
} from "./Types.ts";

export interface ProjectProps {
  /**
   * Project display name. If omitted, Alchemy generates a stable physical name.
   */
  name?: string;
  /**
   * Whether to create a default Prisma Postgres database with the project.
   *
   * @default true
   */
  createDatabase?: boolean;
  /**
   * Region for the default database created with the project.
   *
   * @default "us-east-1"
   */
  region?: string;
  /**
   * Opaque project settings passed through to the Management API.
   */
  settings?: Record<string, unknown>;
}

export interface Project extends Resource<
  "Prisma.Project",
  ProjectProps,
  {
    /**
     * Prisma project ID.
     */
    projectId: string;
    /**
     * Prisma project display name.
     */
    projectName: string;
    /**
     * Workspace ID that owns the project.
     */
    workspaceId: string;
    /**
     * ISO timestamp when the project was created.
     */
    createdAt: string;
    /**
     * Default Prisma Postgres region for the project, when available.
     */
    defaultRegion: string | null;
    /**
     * Default database ID created with or discovered for the project.
     */
    databaseId: string | undefined;
    /**
     * Default database connection ID, when a database exists.
     */
    defaultConnectionId: string | undefined;
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
 * A Prisma project, optionally with a default Prisma Postgres database.
 *
 * @section Creating a Project
 * @example Project with a default database
 * ```typescript
 * const project = yield* Prisma.Project("app", {
 *   name: "app",
 *   region: "us-east-1",
 * });
 * ```
 *
 * @example Project only
 * ```typescript
 * const project = yield* Prisma.Project("control-plane", {
 *   createDatabase: false,
 * });
 * ```
 */
export const Project = Resource<Project>("Prisma.Project");

const createName = (id: string, name: string | undefined) =>
  name === undefined ? createPhysicalName({ id }) : Effect.succeed(name);

const findProjectByName = (client: PrismaManagementClient, name: string) =>
  client
    .listProjects()
    .pipe(
      Effect.map((projects) =>
        projects.find((p: ApiProject) => p.name === name),
      ),
    );

const defaultDatabase = (client: PrismaManagementClient, projectId: string) =>
  client
    .listProjectDatabases(projectId, { limit: 100 })
    .pipe(Effect.map((databases) => databases.find((db) => db.isDefault)));

const attrsFrom = (
  project: ApiProject,
  database: Database | undefined,
  secrets: PrismaSecretConnection,
): Project["Attributes"] => ({
  projectId: project.id,
  projectName: project.name,
  workspaceId: project.workspace.id,
  createdAt: project.createdAt,
  defaultRegion: project.defaultRegion,
  databaseId: database?.id,
  defaultConnectionId: database?.defaultConnectionId ?? undefined,
  connectionString: secrets.connectionString,
  directConnectionString: secrets.directConnectionString,
  pooledConnectionString: secrets.pooledConnectionString,
  accelerateConnectionString: secrets.accelerateConnectionString,
  host: secrets.host,
  user: secrets.user,
  password: secrets.password,
});

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["projectId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          if (isPrismaDevId(output?.projectId)) {
            return { action: "update" } as const;
          }
          const nextName = yield* createName(id, news.name);
          const oldName =
            output?.projectName ?? (yield* createName(id, olds.name));
          if (
            (news.region ?? "us-east-1") !==
              (olds.region ?? output?.defaultRegion ?? "us-east-1") ||
            (news.createDatabase ?? true) !== (olds.createDatabase ?? true)
          ) {
            return { action: "replace" } as const;
          }
          if (
            nextName !== oldName ||
            JSON.stringify(news.settings ?? {}) !==
              JSON.stringify(olds.settings ?? {})
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ id, output, olds = {} }) {
          const projectId = isPrismaDevId(output?.projectId)
            ? undefined
            : output?.projectId;
          const project = projectId
            ? yield* client
                .getProject(projectId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* findProjectByName(
                client,
                yield* createName(id, olds.name),
              );
          if (!project) return undefined;
          const database = yield* defaultDatabase(client, project.id).pipe(
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          return attrsFrom(project, database, {
            connectionString: output?.connectionString,
            directConnectionString: output?.directConnectionString,
            pooledConnectionString: output?.pooledConnectionString,
            accelerateConnectionString: output?.accelerateConnectionString,
            host: output?.host,
            user: output?.user,
            password: output?.password,
          });
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, olds, output }) {
          const name = yield* createName(id, news.name);
          const projectId = isPrismaDevId(output?.projectId)
            ? undefined
            : output?.projectId;
          let project = projectId
            ? yield* client
                .getProject(projectId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* findProjectByName(client, name);

          let createdDatabase: Database | undefined;
          let secrets: PrismaSecretConnection = {};
          if (!project) {
            const result = yield* client
              .createProject({
                name,
                createDatabase: news.createDatabase ?? true,
                region: news.region ?? "us-east-1",
              })
              .pipe(
                Effect.map((project) => ({
                  project,
                  database: project.database ?? undefined,
                  secrets: extractConnectionSecrets(
                    project.database?.connections[0],
                  ),
                })),
                Effect.catchIf(isConflict, () =>
                  findProjectByName(client, name).pipe(
                    Effect.flatMap((project) =>
                      project
                        ? Effect.succeed({
                            project,
                            database: undefined,
                            secrets: {},
                          })
                        : Effect.fail(
                            new Error(
                              `Prisma project '${name}' already exists but could not be read`,
                            ),
                          ),
                    ),
                  ),
                ),
              );
            project = result.project;
            createdDatabase = result.database;
            secrets = result.secrets;
          }

          const settingsChanged =
            JSON.stringify(news.settings ?? {}) !==
            JSON.stringify(olds?.settings ?? {});
          if (project.name !== name || settingsChanged) {
            project = yield* client.updateProject(project.id, {
              name,
              ...(settingsChanged ? { settings: news.settings ?? {} } : {}),
            });
          }

          let database = createdDatabase;
          if (news.createDatabase !== false && !database) {
            database = yield* defaultDatabase(client, project.id).pipe(
              Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
            );
            if (!database) {
              const created = yield* client
                .createProjectDatabase(project.id, {
                  region: news.region ?? "us-east-1",
                  isDefault: true,
                })
                .pipe(
                  Effect.catchIf(isConflict, () =>
                    defaultDatabase(client, project.id).pipe(
                      Effect.flatMap((database) =>
                        database
                          ? Effect.succeed(database)
                          : Effect.fail(
                              new Error(
                                `Prisma project '${name}' database already exists but could not be read`,
                              ),
                            ),
                      ),
                    ),
                  ),
                );
              database = created;
              secrets = extractConnectionSecrets(created.connections[0]);
            }
          }

          return attrsFrom(project, database, {
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
          if (isPrismaDevId(output.projectId)) return;
          yield* destroyComputeProject(client, output.projectId);
        }),
      };
    }),
  );
