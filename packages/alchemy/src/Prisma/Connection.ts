import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
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
import { hasCanonicalConnectionSecrets } from "./Internal/DatabaseSecrets.ts";
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
   * Human-readable connection name prefix. Alchemy appends the resource
   * instance identity because Prisma permits duplicate connection names and
   * exposes no ownership tags.
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
   * Resolves to the pooled Postgres URL first, then direct Postgres, then
   * Accelerate. This is the serverless-safe default for application traffic.
   */
  databaseUrl: Effect.Effect<string | undefined, never, RuntimeContext>;
  /**
   * Conventional direct database URL.
   *
   * Resolves only to the canonical direct Postgres endpoint.
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

export type ConnectionUrlKind = "direct" | "pooled" | "accelerate";
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
 *   appName: "api",
 *   main: import.meta.filename,
 *   env,
 * });
 * ```
 *
 * @example Use a connection inside an Effect-native Compute app
 * ```typescript
 * export default Prisma.Compute(
 *   "api",
 *   { project, appName: "api", main: import.meta.filename },
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
 *
 * @resource
 */
export const Connection = Resource<Connection>("Prisma.Connection");

const fnv1a64 = (value: string) => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0").toUpperCase();
};

const envName = (value: string) => {
  const normalized = value.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  // Preserve the established keys for conventional PascalCase FQNs while
  // disambiguating arbitrary logical IDs whose lossy normalization can
  // collide (`db-a`, `db_a`, and `db.a`, for example).
  const canonical = value
    .split("/")
    .every((segment) => /^[A-Z][a-z0-9]*$/.test(segment));
  return canonical ? normalized : `${normalized}_${fnv1a64(value)}`;
};

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
 * this helper when you want a canonical fallback chain.
 *
 * @default ["pooled", "direct", "accelerate"]
 */
export const connectionUrl = (
  connection: Connection,
  preference: ConnectionUrlPreference = ["pooled", "direct", "accelerate"],
): Output.Output<Redacted.Redacted<string> | undefined> => {
  const preferred = asPreferenceList(preference);
  return Output.all(
    connection.directConnectionString,
    connection.pooledConnectionString,
    connection.accelerateConnectionString,
  ).pipe(
    Output.map(([direct, pooled, accelerate]) =>
      selectedConnectionUrl(
        {
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
 * a deployment's `env` or build command env. `DATABASE_URL` prefers the
 * canonical pooled endpoint, while `DIRECT_URL` is always direct.
 */
export const connectionEnv = <
  const Options extends ConnectionEnvOptions | undefined = undefined,
>(
  connection: Connection,
  options?: Options,
): ConnectionEnv<Options> => {
  const resolved: ConnectionEnvOptions = options ?? {};
  const env: Record<string, ConnectionEnvValue> = {};
  setEnvValue(
    env,
    envKey(resolved.databaseUrl, "DATABASE_URL"),
    connectionUrl(connection),
  );
  setEnvValue(
    env,
    envKey(resolved.directUrl, "DIRECT_URL"),
    connectionUrl(connection, "direct"),
  );
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
      const directConnectionString = runtimeOutput(
        keys.directConnectionString,
        env.directConnectionString,
      ).pipe(Effect.map(optionalString));
      const pooledConnectionString = runtimeOutput(
        keys.pooledConnectionString,
        env.pooledConnectionString,
      ).pipe(Effect.map(optionalString));
      const accelerateConnectionString = runtimeOutput(
        keys.accelerateConnectionString,
        env.accelerateConnectionString,
      ).pipe(Effect.map(optionalString));
      const databaseUrl = Effect.all([
        pooledConnectionString,
        directConnectionString,
        accelerateConnectionString,
      ]).pipe(
        Effect.map(
          ([pooled, direct, accelerate]) => pooled ?? direct ?? accelerate,
        ),
      );
      return {
        databaseUrl,
        directUrl: directConnectionString,
        pooledDatabaseUrl: pooledConnectionString,
        connectionId: runtimeOutput(keys.connectionId, env.connectionId),
        databaseId: runtimeOutput(keys.databaseId, env.databaseId),
        directConnectionString,
        pooledConnectionString,
        accelerateConnectionString,
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
  predicate: (connection: DatabaseConnection) => boolean,
) =>
  client
    .listDatabaseConnections(databaseId, { limit: 100 })
    .pipe(Effect.map((connections) => connections.filter(predicate)));

class AmbiguousPrismaConnectionError extends Error {
  readonly _tag = "AmbiguousPrismaConnectionError";

  constructor(databaseId: string, name: string, count: number) {
    super(
      `Prisma database '${databaseId}' has ${count} connections named '${name}'; use a unique connection name before importing it into Alchemy`,
    );
  }
}

class InvalidPrismaConnectionNameError extends Error {
  readonly _tag = "InvalidPrismaConnectionNameError";

  constructor() {
    super(
      "Prisma connection name must contain at least one non-space character",
    );
  }
}

const validateConnectionName = (name: string) => {
  const trimmed = name.trim();
  return trimmed.length === 0
    ? Effect.fail(new InvalidPrismaConnectionNameError())
    : Effect.succeed(trimmed);
};

const uniqueConnection = (
  client: PrismaManagementClient,
  databaseId: string,
  description: string,
  predicate: (connection: DatabaseConnection) => boolean,
) =>
  findConnection(client, databaseId, predicate).pipe(
    Effect.flatMap((connections) =>
      connections.length <= 1
        ? Effect.succeed(connections[0])
        : Effect.fail(
            new AmbiguousPrismaConnectionError(
              databaseId,
              description,
              connections.length,
            ),
          ),
    ),
  );

class GeneratedConnectionNotVisible extends Error {}

const generatedConnectionRecoverySchedule = Schedule.max([
  Schedule.exponential("250 millis"),
  Schedule.recurs(6),
]);

const recoverGeneratedConnectionAfterConflict = (
  client: PrismaManagementClient,
  databaseId: string,
  expectedName: string,
) =>
  uniqueConnection(
    client,
    databaseId,
    expectedName,
    (candidate) => candidate.name === expectedName,
  ).pipe(
    Effect.flatMap((connection) =>
      connection
        ? Effect.succeed(connection)
        : Effect.fail(
            new GeneratedConnectionNotVisible(
              `Generated Prisma connection '${expectedName}' is not visible yet.`,
            ),
          ),
    ),
    Effect.retry({
      while: (error) => error instanceof GeneratedConnectionNotVisible,
      schedule: generatedConnectionRecoverySchedule,
    }),
  );

const physicalConnectionPrefix = (name: string) =>
  `${name.trim().slice(0, 52)}-`;

const physicalConnectionName = (name: string, instanceId: string) => {
  const instanceToken = instanceId.replaceAll(/[^a-zA-Z0-9]/g, "");
  const effectiveSuffix =
    instanceToken.length >= 12
      ? instanceToken.slice(0, 12)
      : fnv1a64(instanceId).slice(0, 12);
  const maxPrefixLength = 65 - effectiveSuffix.length - 1;
  return `${name.trim().slice(0, maxPrefixLength)}-${effectiveSuffix}`;
};

const isGeneratedPhysicalConnectionName = (
  physicalName: string,
  logicalName: string,
) => {
  const prefix = physicalConnectionPrefix(logicalName);
  return (
    physicalName.startsWith(prefix) &&
    /^[0-9a-f]{12}$/i.test(physicalName.slice(prefix.length))
  );
};

const isAdoptablePhysicalConnectionName = (
  physicalName: string,
  logicalName: string,
) =>
  physicalName === logicalName.trim() ||
  isGeneratedPhysicalConnectionName(physicalName, logicalName);

const attrsFrom = (
  connection: DatabaseConnection | DatabaseConnectionWithSecrets,
  secrets: PrismaSecretConnection,
): Connection["Attributes"] => ({
  connectionId: connection.id,
  connectionName: connection.name,
  databaseId: connection.database.id,
  kind: connection.kind,
  createdAt: connection.createdAt,
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
        list: () =>
          client
            .listConnections()
            .pipe(
              Effect.map((connections) =>
                connections.map((c) => attrsFrom(c, {})),
              ),
            ),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.connectionId)) {
            return { action: "update" } as const;
          }
          const oldDatabaseId =
            output?.databaseId ?? unresolvedDatabaseIdOf(olds.database);
          const newDatabaseId = isResolved(news.database)
            ? unresolvedDatabaseIdOf(news.database)
            : undefined;
          const resolvedName = isResolved(news.name)
            ? yield* validateConnectionName(news.name)
            : undefined;
          const nameChanged =
            resolvedName !== undefined && resolvedName !== olds.name.trim();
          if (concreteIdsChanged(oldDatabaseId, newDatabaseId) || nameChanged) {
            return { action: "replace" } as const;
          }
          if (!isResolved(news.rotate)) return undefined;
          if ((news.rotate ?? false) !== (olds.rotate ?? false)) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ instanceId, output, olds }) {
          const connectionId = isPrismaDevId(output?.connectionId)
            ? undefined
            : output?.connectionId;
          if (connectionId && output) {
            const connection = yield* client
              .getConnection(connectionId)
              .pipe(
                Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
              );
            if (!connection) return undefined;
            if (
              connection.database.id !== output.databaseId ||
              connection.name !== output.connectionName
            ) {
              return yield* Effect.fail(
                new Error(
                  `Prisma connection '${connection.id}' no longer matches persisted database '${output.databaseId}' and name '${output.connectionName}'. Refusing to refresh a mismatched connection.`,
                ),
              );
            }
            const observed = extractConnectionSecrets(connection);
            return attrsFrom(connection, {
              directConnectionString: output?.directConnectionString,
              pooledConnectionString: output?.pooledConnectionString,
              accelerateConnectionString: output?.accelerateConnectionString,
              host: observed.host,
              user: output?.user,
              password: output?.password,
            });
          }

          const databaseId = unresolvedDatabaseIdOf(olds.database);
          if (!databaseId) return undefined;
          const name = yield* validateConnectionName(olds.name);
          const expectedName = physicalConnectionName(name, instanceId);
          const owned = yield* uniqueConnection(
            client,
            databaseId,
            expectedName,
            (connection) => connection.name === expectedName,
          );
          if (owned) return attrsFrom(owned, {});

          const prefix = physicalConnectionPrefix(name);
          const generated = yield* uniqueConnection(
            client,
            databaseId,
            `${prefix}<instance-id>`,
            (connection) =>
              connection.name !== expectedName &&
              isGeneratedPhysicalConnectionName(connection.name, name),
          );
          const connection =
            generated ??
            (yield* uniqueConnection(
              client,
              databaseId,
              name,
              (connection) => connection.name === name,
            ));
          if (!connection) return undefined;
          return Unowned(attrsFrom(connection, {}));
        }),
        reconcile: Effect.fn(function* ({ instanceId, news, olds, output }) {
          const databaseId = yield* resolveDatabaseId(news.database);
          const name = yield* validateConnectionName(news.name);
          const connectionId = isPrismaDevId(output?.connectionId)
            ? undefined
            : output?.connectionId;
          let connection = connectionId
            ? yield* client
                .getConnection(connectionId)
                .pipe(
                  Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
                )
            : undefined;

          const expectedName = physicalConnectionName(name, instanceId);
          const physicalName =
            connectionId && output ? output.connectionName : expectedName;
          if (
            connectionId &&
            !isAdoptablePhysicalConnectionName(physicalName, name)
          ) {
            return yield* Effect.fail(
              new Error(
                `Persisted Prisma connection '${connectionId}' has physical name '${physicalName}', which does not match requested logical name '${name}'. Refusing to adopt or persist a mismatched connection.`,
              ),
            );
          }
          if (
            connection &&
            (connection.database.id !== databaseId ||
              connection.name !== physicalName)
          ) {
            return yield* Effect.fail(
              new Error(
                `Prisma connection '${connection.id}' resolves to database '${connection.database.id}' with name '${connection.name}', not requested database '${databaseId}' and physical name '${physicalName}'. Refusing to rotate or persist mismatched identity; replace the connection instead.`,
              ),
            );
          }

          if (!connection && !connectionId) {
            connection = yield* uniqueConnection(
              client,
              databaseId,
              expectedName,
              (candidate) => candidate.name === expectedName,
            );
          }

          let secrets: PrismaSecretConnection = connection
            ? extractConnectionSecrets(connection)
            : {};
          if (!connection) {
            const create = client.createConnection({
              databaseId,
              name: physicalName,
            });
            connection = yield* physicalName === expectedName
              ? create.pipe(
                  Effect.catchIf(isConflict, () =>
                    recoverGeneratedConnectionAfterConflict(
                      client,
                      databaseId,
                      expectedName,
                    ),
                  ),
                )
              : create;
            secrets = extractConnectionSecrets(connection);
          }
          const missingCanonicalSecrets =
            secrets.directConnectionString === undefined &&
            secrets.pooledConnectionString === undefined &&
            secrets.accelerateConnectionString === undefined &&
            output?.directConnectionString === undefined &&
            output?.pooledConnectionString === undefined &&
            output?.accelerateConnectionString === undefined;
          const recoveringOwnedGeneratedSecrets =
            physicalName === expectedName && missingCanonicalSecrets;
          if (
            recoveringOwnedGeneratedSecrets ||
            (news.rotate === true && olds?.rotate !== true)
          ) {
            const rotated = yield* client.rotateConnection(connection.id);
            if (
              rotated.id !== connection.id ||
              rotated.database.id !== databaseId ||
              rotated.name !== physicalName
            ) {
              return yield* Effect.fail(
                new Error(
                  `Prisma rotated connection '${rotated.id}' for database '${rotated.database.id}' with name '${rotated.name}', but connection '${connection.id}' for database '${databaseId}' with name '${physicalName}' was requested. Refusing to persist mismatched credentials.`,
                ),
              );
            }
            connection = rotated;
            secrets = extractConnectionSecrets(rotated);
            if (!hasCanonicalConnectionSecrets(secrets)) {
              return yield* Effect.fail(
                new Error(
                  `Prisma rotated connection '${connection.id}' for database '${databaseId}' without returning a canonical connection URL. Refusing to persist missing or stale credentials.`,
                ),
              );
            }
          }

          return attrsFrom(connection, {
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
          const connection = yield* client
            .getConnection(output.connectionId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!connection) return;
          if (
            connection.database.id !== output.databaseId ||
            connection.name !== output.connectionName
          ) {
            return yield* Effect.fail(
              new Error(
                `Prisma connection '${connection.id}' no longer matches persisted database '${output.databaseId}' and name '${output.connectionName}'. Refusing to delete a mismatched connection.`,
              ),
            );
          }
          yield* client
            .deleteConnection(connection.id)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      };
    }),
  );
