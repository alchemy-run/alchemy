import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import { isResolved } from "../Diff.ts";
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
  concreteIdsChanged,
  isInputObject,
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

export interface ConnectionBindingClient {
  /**
   * Conventional application database URL.
   *
   * Resolves to the direct Postgres connection string, falling back to the
   * legacy connection string when direct credentials are unavailable.
   */
  databaseUrl: Effect.Effect<string | undefined, never, RuntimeContext>;
  /**
   * Conventional direct database URL.
   *
   * Resolves to the direct Postgres connection string, falling back to the
   * legacy connection string when direct credentials are unavailable.
   */
  directUrl: Effect.Effect<string | undefined, never, RuntimeContext>;
  /**
   * Conventional pooled database URL.
   */
  pooledDatabaseUrl: Effect.Effect<string | undefined, never, RuntimeContext>;
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

/**
 * Bind a {@link Connection} to a Prisma Compute app, AWS Lambda Function, or
 * Cloudflare Worker and obtain the typed runtime client.
 *
 * `ConnectionBinding` is a single identifier that is simultaneously the
 * binding's Context tag, its type, and the callable —
 * `yield* Prisma.ConnectionBinding(connection)`.
 *
 * @binding
 */
export interface ConnectionBinding extends Binding.Service<
  ConnectionBinding,
  "Prisma.Connection",
  (connection: Connection) => Effect.Effect<ConnectionBindingClient>
> {}

export const ConnectionBinding =
  Binding.Service<ConnectionBinding>("Prisma.Connection");

export type ConnectionUrlKind = "legacy" | "direct" | "pooled" | "accelerate";
export type ConnectionUrlPreference =
  | ConnectionUrlKind
  | readonly ConnectionUrlKind[];

export type ConnectionEnvValue = Output.Output<
  string | Redacted.Redacted<string> | undefined
>;

type ConnectionEnvBindingHost = Resource<
  string,
  object | undefined,
  object,
  { env?: Record<string, ConnectionEnvValue> }
>;

type ConnectionWorkerTextBinding =
  | {
      type: "plain_text";
      name: string;
      text: string;
    }
  | {
      type: "secret_text";
      name: string;
      text: string;
    };

type ConnectionWorkerBindingHost = Resource<
  "Cloudflare.Worker",
  object | undefined,
  object,
  { bindings?: ConnectionWorkerTextBinding[] }
>;

const supportsConnectionEnvBinding = (
  host: ResourceLike,
): host is ConnectionEnvBindingHost =>
  host.Type === "Prisma.Compute" || host.Type === "AWS.Lambda.Function";

const supportsConnectionWorkerBinding = (
  host: ResourceLike,
): host is ConnectionWorkerBindingHost => host.Type === "Cloudflare.Worker";

export interface ConnectionEnvOptions {
  /**
   * Env var name for the app-facing database URL. Set to `false` to omit.
   *
   * @default "DATABASE_URL"
   */
  databaseUrl?: string | false;
  /**
   * Env var name for the direct database URL. Set to `false` to omit.
   *
   * @default "DIRECT_URL"
   */
  directUrl?: string | false;
  /**
   * Env var name for the pooled database URL. Set to `false` to omit.
   *
   * @default "POOLED_DATABASE_URL"
   */
  pooledDatabaseUrl?: string | false;
  /**
   * Env var name for the Prisma connection/API key ID. Set to `false` to omit.
   *
   * @default "PRISMA_CONNECTION_ID"
   */
  connectionId?: string | false;
  /**
   * Env var name for the Prisma database ID. Set to `false` to omit.
   *
   * @default "PRISMA_DATABASE_ID"
   */
  databaseId?: string | false;
}

type ConnectionEnvOptionValue<
  Options extends ConnectionEnvOptions | undefined,
  Key extends keyof ConnectionEnvOptions,
> = Options extends ConnectionEnvOptions ? Options[Key] : undefined;

type ConnectionEnvKey<Name, Default extends string> = [Name] extends [false]
  ? never
  : Name extends string
    ? Name
    : Default;

type ConnectionEnvEntry<Name, Default extends string> =
  ConnectionEnvKey<Name, Default> extends infer Key extends string
    ? { [K in Key]: ConnectionEnvValue }
    : {};

export type ConnectionEnv<
  Options extends ConnectionEnvOptions | undefined = undefined,
> = ConnectionEnvEntry<
  ConnectionEnvOptionValue<Options, "databaseUrl">,
  "DATABASE_URL"
> &
  ConnectionEnvEntry<
    ConnectionEnvOptionValue<Options, "directUrl">,
    "DIRECT_URL"
  > &
  ConnectionEnvEntry<
    ConnectionEnvOptionValue<Options, "pooledDatabaseUrl">,
    "POOLED_DATABASE_URL"
  > &
  ConnectionEnvEntry<
    ConnectionEnvOptionValue<Options, "connectionId">,
    "PRISMA_CONNECTION_ID"
  > &
  ConnectionEnvEntry<
    ConnectionEnvOptionValue<Options, "databaseId">,
    "PRISMA_DATABASE_ID"
  >;

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
 * @section Binding to Platforms
 * @example Pass conventional env vars to Compute
 * ```typescript
 * const connection = yield* Prisma.Connection("api", {
 *   database,
 *   name: "api",
 * });
 * const env = Prisma.connectionEnv(connection);
 *
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   serviceName: "api",
 *   main: import.meta.filename,
 *   env,
 * });
 * ```
 *
 * @example Use a connection inside an Effect-native Compute app
 * ```typescript
 * export default Prisma.Compute(
 *   "api",
 *   { project, serviceName: "api", main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const db = yield* Prisma.ConnectionBinding(connection);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const databaseUrl = yield* db.databaseUrl;
 *         return yield* HttpServerResponse.text(databaseUrl ?? "");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Prisma.ConnectionBindingLive)),
 * );
 * ```
 *
 * @example Use a connection inside an Effect-native Lambda function
 * ```typescript
 * export default AWS.Lambda.Function(
 *   "api",
 *   { main: import.meta.filename, url: true },
 *   Effect.gen(function* () {
 *     const db = yield* Prisma.ConnectionBinding(connection);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const databaseUrl = yield* db.databaseUrl;
 *         return yield* HttpServerResponse.text(databaseUrl ?? "");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Prisma.ConnectionBindingLive)),
 * );
 * ```
 *
 * @example Use a connection inside an Effect-native Cloudflare Worker
 * ```typescript
 * export default Cloudflare.Worker(
 *   "api",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     const db = yield* Prisma.ConnectionBinding(connection);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const databaseUrl = yield* db.databaseUrl;
 *         return yield* HttpServerResponse.text(databaseUrl ?? "");
 *       }),
 *     };
 *   }).pipe(Effect.provide(Prisma.ConnectionBindingLive)),
 * );
 * ```
 */
export const Connection = Resource<Connection>("Prisma.Connection");

const envName = (value: string) =>
  value.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();

const asPreferenceList = (
  preference: ConnectionUrlPreference,
): readonly ConnectionUrlKind[] =>
  typeof preference === "string" ? [preference] : preference;

const selectedConnectionUrl = (
  values: Record<ConnectionUrlKind, Redacted.Redacted<string> | undefined>,
  preference: readonly ConnectionUrlKind[],
) => {
  for (const kind of preference) {
    const value = values[kind];
    if (value !== undefined) return value;
  }
  return undefined;
};

/**
 * Resolve a connection URL from a Prisma Connection using Output-safe
 * fallback logic.
 *
 * JavaScript operators like `??` run before Alchemy Outputs resolve, so use
 * this helper when you want a fallback chain such as direct-then-legacy.
 *
 * @default ["direct", "legacy"]
 */
export const connectionUrl = (
  connection: Connection,
  preference: ConnectionUrlPreference = ["direct", "legacy"],
): Output.Output<Redacted.Redacted<string> | undefined> => {
  const preferred = asPreferenceList(preference);
  return Output.all(
    connection.connectionString,
    connection.directConnectionString,
    connection.pooledConnectionString,
    connection.accelerateConnectionString,
  ).pipe(
    Output.map(([legacy, direct, pooled, accelerate]) =>
      selectedConnectionUrl(
        {
          legacy,
          direct,
          pooled,
          accelerate,
        },
        preferred,
      ),
    ),
  );
};

const envKey = (name: string | false | undefined, defaultName: string) =>
  name === false ? undefined : (name ?? defaultName);

const setEnvValue = (
  env: Record<string, ConnectionEnvValue>,
  key: string | undefined,
  value: ConnectionEnvValue,
) => {
  if (key !== undefined) {
    env[key] = value;
  }
};

/**
 * Build conventional environment variables for a Prisma Connection.
 *
 * The returned values are Alchemy Outputs, so they can be passed directly to
 * `Prisma.Compute({ env })` or build command env. `DATABASE_URL` and
 * `DIRECT_URL` use the direct connection string with a legacy fallback.
 */
export const connectionEnv = <
  const Options extends ConnectionEnvOptions | undefined = undefined,
>(
  connection: Connection,
  options?: Options,
): ConnectionEnv<Options> => {
  const resolved: ConnectionEnvOptions = options ?? {};
  const env: Record<string, ConnectionEnvValue> = {};
  const appUrl = connectionUrl(connection);
  setEnvValue(env, envKey(resolved.databaseUrl, "DATABASE_URL"), appUrl);
  setEnvValue(env, envKey(resolved.directUrl, "DIRECT_URL"), appUrl);
  setEnvValue(
    env,
    envKey(resolved.pooledDatabaseUrl, "POOLED_DATABASE_URL"),
    connectionUrl(connection, "pooled"),
  );
  setEnvValue(
    env,
    envKey(resolved.connectionId, "PRISMA_CONNECTION_ID"),
    connection.connectionId,
  );
  setEnvValue(
    env,
    envKey(resolved.databaseId, "PRISMA_DATABASE_ID"),
    connection.databaseId,
  );
  return env as ConnectionEnv<Options>;
};

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
const ENCODED_CONNECTION_PREFIX = "__ALCHEMY_PRISMA_CONNECTION_VALUE__:";

type EncodedConnectionValue =
  | { readonly kind: "undefined" }
  | { readonly kind: "null" }
  | { readonly kind: "value"; readonly value: string };

const encodeConnectionValue = (value: EncodedConnectionValue) =>
  `${ENCODED_CONNECTION_PREFIX}${JSON.stringify(value)}`;

const escapePrefixedValue = <A extends string | Redacted.Redacted<string>>(
  value: A,
): A | string | Redacted.Redacted<string> => {
  const raw = typeof value === "string" ? value : String(Redacted.value(value));
  if (!raw.startsWith(ENCODED_CONNECTION_PREFIX)) return value;
  const encoded = encodeConnectionValue({ kind: "value", value: raw });
  return Redacted.isRedacted(value) ? Redacted.make(encoded) : encoded;
};

const encodeOptionalValue = <A extends string | Redacted.Redacted<string>>(
  output: Output.Output<A | null | undefined>,
): Output.Output<A | string | Redacted.Redacted<string>> =>
  output.pipe(
    Output.map((value) =>
      value === undefined
        ? encodeConnectionValue({ kind: "undefined" })
        : value === null
          ? encodeConnectionValue({ kind: "null" })
          : escapePrefixedValue(value),
    ),
  ) as Output.Output<A | string | Redacted.Redacted<string>>;

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

const workerBindingValue = (
  name: string,
  value: ConnectionEnvValue,
): Output.Output<ConnectionWorkerTextBinding> =>
  value.pipe(
    Output.map((resolved) => {
      if (Redacted.isRedacted(resolved)) {
        return {
          type: "secret_text",
          name,
          text: Redacted.value(resolved),
        };
      }
      return {
        type: "plain_text",
        name,
        text: resolved ?? encodeConnectionValue({ kind: "undefined" }),
      };
    }),
  );

const connectionWorkerBindings = (
  connection: Connection,
): Output.Output<ConnectionWorkerTextBinding>[] => {
  const keys = connectionBindingEnvKeys(connection);
  const env = encodedConnectionBindingEnv(connection);
  return [
    workerBindingValue(keys.connectionId, env.connectionId),
    workerBindingValue(keys.databaseId, env.databaseId),
    workerBindingValue(keys.connectionString, env.connectionString),
    workerBindingValue(keys.directConnectionString, env.directConnectionString),
    workerBindingValue(keys.pooledConnectionString, env.pooledConnectionString),
    workerBindingValue(
      keys.accelerateConnectionString,
      env.accelerateConnectionString,
    ),
    workerBindingValue(keys.host, env.host),
    workerBindingValue(keys.user, env.user),
    workerBindingValue(keys.password, env.password),
  ];
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

const decodeConnectionValue = (
  value: Redacted.Redacted<string> | string,
): string | null | undefined => {
  const raw = redactedToString(value);
  if (raw === undefined || !raw.startsWith(ENCODED_CONNECTION_PREFIX)) {
    return raw;
  }
  try {
    const parsed = JSON.parse(raw.slice(ENCODED_CONNECTION_PREFIX.length));
    if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) {
      return raw;
    }
    if (parsed.kind === "undefined") return undefined;
    if (parsed.kind === "null") return null;
    if (parsed.kind === "value" && typeof parsed.value === "string") {
      return parsed.value;
    }
    return raw;
  } catch {
    return raw;
  }
};

const optionalString = (
  value: Redacted.Redacted<string> | string,
): string | undefined => decodeConnectionValue(value) ?? undefined;

const nullableString = (
  value: Redacted.Redacted<string> | string,
): string | null | undefined => decodeConnectionValue(value);

export const ConnectionBindingLive = Layer.effect(
  ConnectionBinding,
  Effect.gen(function* () {
    return Effect.fn(function* (connection: Connection) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (supportsConnectionEnvBinding(host)) {
          yield* host.bind`${connection}`({
            env: connectionBindingEnv(connection),
          });
        } else if (supportsConnectionWorkerBinding(host)) {
          yield* host.bind`${connection}`({
            bindings: connectionWorkerBindings(connection),
          });
        } else {
          return yield* Effect.die(
            new Error(
              `Prisma.ConnectionBinding supports Prisma.Compute, AWS.Lambda.Function, and Cloudflare.Worker runtimes, got '${host.Type}'`,
            ),
          );
        }
      }
      const keys = connectionBindingEnvKeys(connection);
      const env = encodedConnectionBindingEnv(connection);
      const connectionString = runtimeOutput(
        keys.connectionString,
        env.connectionString,
      ).pipe(Effect.map(optionalString));
      const directConnectionString = runtimeOutput(
        keys.directConnectionString,
        env.directConnectionString,
      ).pipe(Effect.map(optionalString));
      const pooledConnectionString = runtimeOutput(
        keys.pooledConnectionString,
        env.pooledConnectionString,
      ).pipe(Effect.map(optionalString));
      const databaseUrl = Effect.all([
        directConnectionString,
        connectionString,
      ]).pipe(Effect.map(([direct, legacy]) => direct ?? legacy));
      return {
        databaseUrl,
        directUrl: databaseUrl,
        pooledDatabaseUrl: pooledConnectionString,
        connectionId: runtimeOutput(keys.connectionId, env.connectionId),
        databaseId: runtimeOutput(keys.databaseId, env.databaseId),
        connectionString,
        directConnectionString,
        pooledConnectionString,
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
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.connectionId)) {
            return { action: "update" } as const;
          }
          const oldDatabaseId = unresolvedDatabaseIdOf(olds.database);
          const newDatabaseId = isResolved(news.database)
            ? unresolvedDatabaseIdOf(news.database)
            : undefined;
          if (
            concreteIdsChanged(oldDatabaseId, newDatabaseId) ||
            (isResolved(news.name) && news.name !== olds.name)
          ) {
            return { action: "replace" } as const;
          }
          if (!isResolved(news.rotate)) return undefined;
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
