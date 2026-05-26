import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import * as Output from "../Output.ts";
import * as Provider from "../Provider.ts";
import { Resource, type ResourceLike } from "../Resource.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
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
import { isCompute } from "./Compute.ts";

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

export interface ConnectionBindingClient {
  /**
   * Prisma connection/API key ID.
   */
  connectionId: Effect.Effect<string, never, RuntimeContext>;
  /**
   * Database ID this connection belongs to.
   */
  databaseId: Effect.Effect<string, never, RuntimeContext>;
  /**
   * Legacy connection string, when available.
   */
  connectionString: Effect.Effect<string | undefined, never, RuntimeContext>;
  /**
   * Direct Postgres connection string, when available.
   */
  directConnectionString: Effect.Effect<
    string | undefined,
    never,
    RuntimeContext
  >;
  /**
   * Pooled Prisma Postgres connection string, when available.
   */
  pooledConnectionString: Effect.Effect<
    string | undefined,
    never,
    RuntimeContext
  >;
  /**
   * Accelerate connection string, when available.
   */
  accelerateConnectionString: Effect.Effect<
    string | undefined,
    never,
    RuntimeContext
  >;
  /**
   * Direct database host, when available.
   */
  host: Effect.Effect<string | null | undefined, never, RuntimeContext>;
  /**
   * Direct database user, when available.
   */
  user: Effect.Effect<string | null | undefined, never, RuntimeContext>;
  /**
   * Direct database password, when available.
   */
  password: Effect.Effect<string | undefined, never, RuntimeContext>;
}

export interface ConnectionBindingEnvKeys {
  connectionId: string;
  databaseId: string;
  connectionString: string;
  directConnectionString: string;
  pooledConnectionString: string;
  accelerateConnectionString: string;
  host: string;
  user: string;
  password: string;
}

export class ConnectionBinding extends Binding.Service<
  ConnectionBinding,
  (connection: Connection) => Effect.Effect<ConnectionBindingClient>
>()("Prisma.Connection") {}

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
 *
 * @section Binding to Compute
 * @example Use a connection inside an Effect-native app
 * ```typescript
 * const connection = yield* Prisma.Connection("api", {
 *   database,
 *   name: "api",
 * });
 *
 * export default Prisma.Compute(
 *   "api",
 *   { project, serviceName: "api", main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const db = yield* Prisma.Connection.bind(connection);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const databaseUrl = yield* db.directConnectionString;
 *         return yield* HttpServerResponse.text(databaseUrl ?? "");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Prisma.ConnectionBindingLive)),
 * );
 * ```
 */
export const Connection = Resource<Connection>("Prisma.Connection")({
  bind: ConnectionBinding.bind,
});

const envName = (value: string) =>
  value.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();

export const connectionBindingEnvKeys = (
  connection: Pick<Connection, "FQN" | "LogicalId">,
): ConnectionBindingEnvKeys => {
  const name =
    connection.FQN === connection.LogicalId
      ? connection.LogicalId
      : connection.FQN;
  const prefix = `PRISMA_${envName(name)}`;
  return {
    connectionId: `${prefix}_CONNECTION_ID`,
    databaseId: `${prefix}_DATABASE_ID`,
    connectionString: `${prefix}_CONNECTION_STRING`,
    directConnectionString: `${prefix}_DIRECT_CONNECTION_STRING`,
    pooledConnectionString: `${prefix}_POOLED_CONNECTION_STRING`,
    accelerateConnectionString: `${prefix}_ACCELERATE_CONNECTION_STRING`,
    host: `${prefix}_HOST`,
    user: `${prefix}_USER`,
    password: `${prefix}_PASSWORD`,
  };
};

// Compute env sync omits undefined and treats null as deletion. Connection
// bindings need both values to round-trip into the typed runtime client.
const UNDEFINED_CONNECTION_VALUE = "__ALCHEMY_PRISMA_CONNECTION_UNDEFINED__";
const NULL_CONNECTION_VALUE = "__ALCHEMY_PRISMA_CONNECTION_NULL__";

const encodeOptionalValue = <A extends string | Redacted.Redacted<string>>(
  output: Output.Output<A | null | undefined>,
): Output.Output<A | string> =>
  output.pipe(
    Output.map((value) =>
      value === undefined
        ? UNDEFINED_CONNECTION_VALUE
        : value === null
          ? NULL_CONNECTION_VALUE
          : value,
    ),
  ) as Output.Output<A | string>;

const encodedConnectionBindingEnv = (connection: Connection) => ({
  connectionId: connection.connectionId,
  databaseId: connection.databaseId,
  connectionString: encodeOptionalValue(connection.connectionString),
  directConnectionString: encodeOptionalValue(
    connection.directConnectionString,
  ),
  pooledConnectionString: encodeOptionalValue(
    connection.pooledConnectionString,
  ),
  accelerateConnectionString: encodeOptionalValue(
    connection.accelerateConnectionString,
  ),
  host: encodeOptionalValue(connection.host),
  user: encodeOptionalValue(connection.user),
  password: encodeOptionalValue(connection.password),
});

const connectionBindingEnv = (connection: Connection) => {
  const keys = connectionBindingEnvKeys(connection);
  const env = encodedConnectionBindingEnv(connection);
  return {
    [keys.connectionId]: env.connectionId,
    [keys.databaseId]: env.databaseId,
    [keys.connectionString]: env.connectionString,
    [keys.directConnectionString]: env.directConnectionString,
    [keys.pooledConnectionString]: env.pooledConnectionString,
    [keys.accelerateConnectionString]: env.accelerateConnectionString,
    [keys.host]: env.host,
    [keys.user]: env.user,
    [keys.password]: env.password,
  };
};

const redactedToString = (
  value: Redacted.Redacted<string> | string | undefined,
): string | undefined =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const runtimeOutput = <A>(
  key: string,
  output: Output.Output<A>,
): Effect.Effect<A, never, RuntimeContext> =>
  output.bind(key).pipe(Effect.flatMap((effect) => effect));

const optionalString = (
  value: Redacted.Redacted<string> | string,
): string | undefined =>
  value === UNDEFINED_CONNECTION_VALUE ? undefined : redactedToString(value);

const nullableString = (value: string): string | null | undefined =>
  value === UNDEFINED_CONNECTION_VALUE
    ? undefined
    : value === NULL_CONNECTION_VALUE
      ? null
      : value;

export const ConnectionBindingLive = Layer.effect(
  ConnectionBinding,
  Effect.gen(function* () {
    const policy = yield* ConnectionBindingPolicy;

    return Effect.fn(function* (connection: Connection) {
      yield* policy(connection);
      const keys = connectionBindingEnvKeys(connection);
      const env = encodedConnectionBindingEnv(connection);
      return {
        connectionId: runtimeOutput(keys.connectionId, env.connectionId),
        databaseId: runtimeOutput(keys.databaseId, env.databaseId),
        connectionString: runtimeOutput(
          keys.connectionString,
          env.connectionString,
        ).pipe(Effect.map(optionalString)),
        directConnectionString: runtimeOutput(
          keys.directConnectionString,
          env.directConnectionString,
        ).pipe(Effect.map(optionalString)),
        pooledConnectionString: runtimeOutput(
          keys.pooledConnectionString,
          env.pooledConnectionString,
        ).pipe(Effect.map(optionalString)),
        accelerateConnectionString: runtimeOutput(
          keys.accelerateConnectionString,
          env.accelerateConnectionString,
        ).pipe(Effect.map(optionalString)),
        host: runtimeOutput(keys.host, env.host).pipe(
          Effect.map(nullableString),
        ),
        user: runtimeOutput(keys.user, env.user).pipe(
          Effect.map(nullableString),
        ),
        password: runtimeOutput(keys.password, env.password).pipe(
          Effect.map(optionalString),
        ),
      } satisfies ConnectionBindingClient;
    });
  }),
);

export class ConnectionBindingPolicy extends Binding.Policy<
  ConnectionBindingPolicy,
  (connection: Connection) => Effect.Effect<void>
>()("Prisma.Connection") {}

export const ConnectionBindingPolicyLive =
  ConnectionBindingPolicy.layer.succeed(
    Effect.fnUntraced(function* (host: ResourceLike, connection: Connection) {
      if (!isCompute(host)) {
        return yield* Effect.die(
          new Error(
            `Prisma.Connection.bind does not support runtime '${host.Type}'`,
          ),
        );
      }

      yield* host.bind`${connection}`({
        env: connectionBindingEnv(connection),
      });
    }),
  );

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
