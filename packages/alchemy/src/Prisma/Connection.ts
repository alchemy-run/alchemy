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
import type { Database } from "./Database.ts";
import type { Providers } from "./Providers.ts";
import {
  isPrismaDevId,
  resolveDatabaseId,
  unresolvedDatabaseIdOf,
} from "./Refs.ts";
import type {
  DatabaseConnection,
  DatabaseConnectionWithSecrets,
  PrismaSecretConnection,
} from "./Types.ts";

export interface ConnectionProps {
  /**
   * Database ID or `database.databaseId` output this connection belongs to.
   */
  database: string | Database;
  /**
   * Connection display name.
   */
  name: string;
  /**
   * Rotate credentials during the next update while keeping the connection ID.
   *
   * @default false
   */
  rotate?: boolean;
}

export interface Connection extends Resource<
  "Prisma.Connection",
  ConnectionProps,
  {
    /**
     * Prisma connection/API key ID.
     */
    connectionId: string;
    /**
     * Connection display name.
     */
    connectionName: string;
    /**
     * Database ID this connection belongs to.
     */
    databaseId: string;
    /**
     * Connection kind returned by Prisma.
     */
    kind: "postgres" | "accelerate";
    /**
     * ISO timestamp when the connection was created.
     */
    createdAt: string;
    /**
     * Legacy connection string returned on create/rotate, redacted in state.
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
 * A Prisma database connection/API key.
 *
 * @section Creating a Connection
 * @example Application connection
 * ```typescript
 * const connection = yield* Prisma.Connection("api", {
 *   database: database.databaseId,
 *   name: "api",
 * });
 * ```
 */
export const Connection = Resource<Connection>("Prisma.Connection");

const findConnection = (
  client: PrismaManagementClient,
  databaseId: string,
  name: string,
) =>
  client
    .listDatabaseConnections(databaseId, { limit: 100 })
    .pipe(
      Effect.map((connections) =>
        connections.find((c: DatabaseConnection) => c.name === name),
      ),
    );

const attrsFrom = (
  connection: DatabaseConnection | DatabaseConnectionWithSecrets,
  secrets: PrismaSecretConnection,
): Connection["Attributes"] => ({
  connectionId: connection.id,
  connectionName: connection.name,
  databaseId: connection.database.id,
  kind: connection.kind,
  createdAt: connection.createdAt,
  connectionString: secrets.connectionString,
  directConnectionString: secrets.directConnectionString,
  pooledConnectionString: secrets.pooledConnectionString,
  accelerateConnectionString: secrets.accelerateConnectionString,
  host: secrets.host,
  user: secrets.user,
  password: secrets.password,
});

export const ConnectionProvider = () =>
  Provider.effect(
    Connection,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["connectionId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (isPrismaDevId(output?.connectionId)) {
            return { action: "update" } as const;
          }
          const oldDatabaseId = unresolvedDatabaseIdOf(olds.database);
          const newDatabaseId = unresolvedDatabaseIdOf(news.database);
          if (oldDatabaseId === undefined || newDatabaseId === undefined) {
            return undefined;
          }
          if (newDatabaseId !== oldDatabaseId || news.name !== olds.name) {
            return { action: "replace" } as const;
          }
          if ((news.rotate ?? false) !== (olds.rotate ?? false)) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          const connectionId = isPrismaDevId(output?.connectionId)
            ? undefined
            : output?.connectionId;
          const connection = connectionId
            ? yield* client
                .getConnection(connectionId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* Effect.gen(function* () {
                const databaseId = unresolvedDatabaseIdOf(olds.database);
                return databaseId
                  ? yield* findConnection(client, databaseId, olds.name)
                  : undefined;
              });
          if (!connection) return undefined;
          return attrsFrom(connection, {
            connectionString: output?.connectionString,
            directConnectionString: output?.directConnectionString,
            pooledConnectionString: output?.pooledConnectionString,
            accelerateConnectionString: output?.accelerateConnectionString,
            host: output?.host,
            user: output?.user,
            password: output?.password,
          });
        }),
        reconcile: Effect.fn(function* ({ news, olds, output }) {
          const databaseId = yield* resolveDatabaseId(news.database);
          const connectionId = isPrismaDevId(output?.connectionId)
            ? undefined
            : output?.connectionId;
          let connection = connectionId
            ? yield* client
                .getConnection(connectionId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : yield* findConnection(client, databaseId, news.name);

          let secrets: PrismaSecretConnection = {};
          let createdConnection = false;
          if (!connection) {
            const result = yield* client
              .createConnection({
                databaseId,
                name: news.name,
              })
              .pipe(
                Effect.map((connection) => ({
                  connection,
                  secrets: extractConnectionSecrets(connection),
                  created: true,
                })),
                Effect.catchIf(isConflict, () =>
                  findConnection(client, databaseId, news.name).pipe(
                    Effect.flatMap((connection) =>
                      connection
                        ? Effect.succeed({
                            connection,
                            secrets: {},
                            created: false,
                          })
                        : Effect.fail(
                            new Error(
                              `Prisma connection '${news.name}' already exists but could not be read`,
                            ),
                          ),
                    ),
                  ),
                ),
              );
            connection = result.connection;
            secrets = result.secrets;
            createdConnection = result.created;
          }
          if (
            !createdConnection &&
            (news.rotate ?? false) !== (olds?.rotate ?? false)
          ) {
            const rotated = yield* client.rotateConnection(connection.id);
            connection = rotated;
            secrets = extractConnectionSecrets(rotated);
          }

          return attrsFrom(connection, {
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
          if (isPrismaDevId(output.connectionId)) return;
          yield* client
            .deleteConnection(output.connectionId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      };
    }),
  );
