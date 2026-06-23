import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { Server, ServerOptions } from "@prisma/dev";
import type { DatabaseDev } from "./Database.ts";

export interface PrismaDevDatabaseAttrs {
  connectionString: Redacted.Redacted<string>;
  directConnectionString: Redacted.Redacted<string>;
  pooledConnectionString: Redacted.Redacted<string>;
  accelerateConnectionString: Redacted.Redacted<string>;
  host: string | null;
  user: string | null;
  password: Redacted.Redacted<string> | undefined;
}

interface PrismaDevDatabaseEntry {
  optionsKey: string;
  migrationKey: string | undefined;
  server: Server;
  attrs: PrismaDevDatabaseAttrs;
}

const servers = new Map<string, PrismaDevDatabaseEntry>();
const startMutex = Semaphore.makeUnsafe(1);

const toError = (message: string) => (cause: unknown) =>
  cause instanceof Error ? cause : new Error(`${message}: ${String(cause)}`);

const importPrismaDev = Effect.tryPromise({
  try: () => import("@prisma/dev"),
  catch: toError("Failed to load @prisma/dev"),
});

const stableJson = (value: unknown) =>
  Effect.sync(() => JSON.stringify(value) ?? "");

const sanitizeName = (value: string) =>
  value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "alchemy";

const optionsFrom = (databaseId: string, dev: DatabaseDev): ServerOptions => ({
  name: dev.name ?? `alchemy-${sanitizeName(databaseId)}`,
  persistenceMode: dev.persistenceMode ?? "stateful",
  port: dev.port,
  databasePort: dev.databasePort,
  shadowDatabasePort: dev.shadowDatabasePort,
  debug: dev.debug,
  databaseConnectTimeoutMillis: dev.databaseConnectTimeoutMillis,
  databaseIdleTimeoutMillis: dev.databaseIdleTimeoutMillis,
  shadowDatabaseConnectTimeoutMillis: dev.shadowDatabaseConnectTimeoutMillis,
  shadowDatabaseIdleTimeoutMillis: dev.shadowDatabaseIdleTimeoutMillis,
});

const parseUrl = (label: string, value: string) =>
  Effect.try({
    try: () => new URL(value),
    catch: toError(`Invalid ${label} connection string`),
  });

const normalizeConnectionString = Effect.fn(function* (value: string) {
  const url = yield* parseUrl("local Prisma", value);
  if (
    url.hostname === "localhost" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  ) {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
});

const detailsFrom = Effect.fn(function* (value: string) {
  const url = yield* parseUrl("direct Prisma", value);
  return yield* Effect.try({
    try: () => ({
      host: url.hostname || null,
      user: url.username ? decodeURIComponent(url.username) : null,
      password: url.password
        ? Redacted.make(decodeURIComponent(url.password))
        : undefined,
    }),
    catch: toError("Invalid direct Prisma credentials"),
  });
});

export const prismaDevDatabaseAttrsFromServer = Effect.fn(function* (
  server: Server,
) {
  const direct = yield* normalizeConnectionString(
    server.database.prismaORMConnectionString ??
      server.database.connectionString,
  );
  const pooled = server.ppg.url;
  const details = yield* detailsFrom(direct);
  return {
    connectionString: Redacted.make(pooled),
    directConnectionString: Redacted.make(direct),
    pooledConnectionString: Redacted.make(pooled),
    accelerateConnectionString: Redacted.make(pooled),
    host: details.host,
    user: details.user,
    password: details.password,
  };
});

const startServer = Effect.fn(function* (
  databaseId: string,
  options: ServerOptions,
) {
  const prismaDev = yield* importPrismaDev;
  return yield* Semaphore.withPermits(
    startMutex,
    1,
  )(
    Effect.tryPromise({
      try: () => prismaDev.startPrismaDevServer(options),
      catch: toError(`Failed to start local Prisma database ${databaseId}`),
    }),
  );
});

const closeEntry = Effect.fn(function* (entry: PrismaDevDatabaseEntry) {
  yield* Effect.tryPromise({
    try: () => entry.server.close(),
    catch: toError("Failed to stop local Prisma database"),
  });
});

const collect = Effect.fn(function* (stream: Stream.Stream<Uint8Array, Error>) {
  return yield* Stream.mkString(Stream.decodeText(stream));
});

const runMigration = Effect.fn(function* (
  dev: DatabaseDev,
  attrs: PrismaDevDatabaseAttrs,
) {
  const path = yield* Path.Path;
  const command = dev.migrate;
  if (command === undefined || command.trim() === "") return;

  const cwd = dev.migrateCwd ? path.resolve(dev.migrateCwd) : path.resolve(".");
  const handle = yield* ChildProcess.make(command, [], {
    shell: true,
    cwd,
    env: {
      DATABASE_URL: Redacted.value(attrs.directConnectionString),
      DIRECT_URL: Redacted.value(attrs.directConnectionString),
      POOLED_DATABASE_URL: Redacted.value(attrs.connectionString),
    },
    extendEnv: true,
    stdin: "ignore",
  });
  const [exitCode, stdout, stderr] = yield* Effect.all(
    [handle.exitCode, collect(handle.stdout), collect(handle.stderr)] as const,
    { concurrency: 3 },
  );
  if (exitCode !== 0) {
    return yield* Effect.fail(
      new Error(
        `Local Prisma migration command failed with exit code ${exitCode}${stderr ? `\n${stderr}` : ""}`,
      ),
    );
  }
  if (stdout) yield* Effect.logDebug("Local Prisma migration output", stdout);
  if (stderr) yield* Effect.logDebug("Local Prisma migration stderr", stderr);
});

export const ensurePrismaDevDatabase = Effect.fn(function* (
  databaseId: string,
  dev: false | DatabaseDev | undefined,
) {
  if (dev === false) return undefined;
  const config: DatabaseDev = dev ?? {};
  if (config.provider !== undefined && config.provider !== "@prisma/dev") {
    return yield* Effect.fail(
      new Error(
        `Unsupported Prisma local database provider ${config.provider}`,
      ),
    );
  }

  const options = optionsFrom(databaseId, config);
  const optionsKey = yield* stableJson(options);
  const cached = servers.get(databaseId);
  let entry = cached;
  if (entry === undefined || entry.optionsKey !== optionsKey) {
    if (entry !== undefined) {
      yield* closeEntry(entry).pipe(Effect.catch(() => Effect.void));
      servers.delete(databaseId);
    }
    const server = yield* startServer(databaseId, options);
    const attrs = yield* prismaDevDatabaseAttrsFromServer(server);
    entry = { optionsKey, migrationKey: undefined, server, attrs };
    servers.set(databaseId, entry);
  }

  if (config.migrate !== undefined && config.migrate.trim() !== "") {
    const migrationKey = yield* stableJson({
      command: config.migrate,
      cwd: config.migrateCwd,
      optionsKey,
    });
    if (entry.migrationKey !== migrationKey) {
      yield* runMigration(config, entry.attrs);
      entry.migrationKey = migrationKey;
    }
  }

  return entry.attrs;
});

export const closePrismaDevDatabase = Effect.fn(function* (databaseId: string) {
  const entry = servers.get(databaseId);
  if (entry === undefined) return;
  yield* closeEntry(entry).pipe(Effect.catch(() => Effect.void));
  servers.delete(databaseId);
});

export const closePrismaDevDatabases = Effect.fn(function* () {
  const ids = Array.from(servers.keys());
  for (const id of ids) {
    yield* closePrismaDevDatabase(id);
  }
});
