import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../Diff.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import * as Provider from "../Provider.ts";
import {
  hashImports,
  hashMigrations,
  listSqlFiles,
  readSqlFile,
} from "../SQL/SqlFile.ts";
import { recordsEqual } from "../Util/equal.ts";
import { Docker } from "../Docker/Docker.ts";
import { DockerLive } from "../Docker/Docker.ts";
import { Database } from "./Database.ts";
import type { DatabaseProps, DockerDatabaseProps } from "./Database.ts";
import { applyMigrations, runSql, PgError } from "./Migrations.ts";
import {
  buildConnectionUri,
  parsePostgresOrigin,
  type PostgresOrigin,
} from "./PostgresOrigin.ts";

const DEFAULT_MIGRATIONS_TABLE = "__alchemy_migrations";
const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 5432;

const rootDir = Effect.sync(() => process.cwd());

const makeContainerName = (id: string) => `alchemy-postgres-${id}`;
const makeVolumePath = (id: string) => `.alchemy/storage/postgres/${id}/data`;

// --- Connection resolution helpers ---

const resolveLiveOrigin = (news: DatabaseProps): PostgresOrigin => {
  if (news.connectionString) {
    return parsePostgresOrigin(news.connectionString);
  }
  const host = news.host ?? DEFAULT_HOST;
  const port = news.port ?? DEFAULT_PORT;
  const user = news.user ?? "postgres";
  const password = news.password ?? "";
  const database = news.database ?? "postgres";
  return {
    scheme: "postgres" as const,
    host,
    port,
    database,
    user,
    password: Redacted.make(password),
  };
};

const resolvePassthroughOrigin = (
  dev: NonNullable<DatabaseProps["dev"]>,
  news: DatabaseProps,
): PostgresOrigin => {
  if (dev.connectionString) {
    return parsePostgresOrigin(dev.connectionString);
  }
  const host = dev.host ?? news.host ?? DEFAULT_HOST;
  const port = dev.port ?? news.port ?? DEFAULT_PORT;
  const user = dev.user ?? news.user ?? "postgres";
  const password = dev.password ?? news.password ?? "";
  const database = dev.database ?? news.database ?? "postgres";
  return {
    scheme: "postgres" as const,
    host,
    port,
    database,
    user,
    password: Redacted.make(password),
  };
};

const resolveDockerOrigin = (
  id: string,
  dockerConfig: DockerDatabaseProps,
  news: DatabaseProps,
) =>
  Effect.gen(function* () {
    const docker = yield* Docker;
    const image = dockerConfig.image ?? "postgres:18-alpine";
    const port = dockerConfig.port ?? 5432;

    const user = news.user ?? "postgres";
    const passwordStr = news.password ?? "password";
    const database = news.database ?? "postgres";

    const name = makeContainerName(id);
    const volumePath = makeVolumePath(id);

    const inspected = yield* docker.container.inspect(name).pipe(
      Effect.catchAll(() => Effect.succeed(undefined)),
    );

    if (!inspected) {
      yield* docker.container.create({
        name,
        image,
        command: undefined,
        env: {
          POSTGRES_USER: user,
          POSTGRES_PASSWORD: passwordStr,
          POSTGRES_DB: database,
        },
        volume: [`${volumePath}:/var/lib/postgresql/data`],
        p: [`${port}:5432/tcp`],
        restart: "unless-stopped",
        rm: false,
        "health-cmd": `pg_isready -U ${user}`,
        "health-interval": "5s",
        "health-timeout": "5s",
        "health-retries": 5,
        "health-start-period": undefined,
        "health-start-interval": undefined,
        "stop-timeout": "10s",
        label: {},
      });
    }

    yield* docker.container.start(name);

    const connectionUri = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(passwordStr)}@${DEFAULT_HOST}:${port}/${database}`;

    // Poll pg connection until ready (up to ~60s)
    yield* Effect.retry(
      Effect.tryPromise({
        try: async () => {
          const { Client } = await import("pg");
          const client = new Client({ connectionString: connectionUri });
          await client.connect();
          await client.end();
        },
        catch: () =>
          new PgError({ message: "Postgres not ready — retrying..." }),
      }),
      { schedule: Schedule.spaced("2 seconds"), times: 30 },
    );

    return {
      scheme: "postgres" as const,
      host: DEFAULT_HOST,
      port,
      database,
      user,
      password: Redacted.make(passwordStr),
    };
  });

// --- Migration helpers ---

const runMigrations = (
  connectionUri: Redacted.Redacted<string>,
  migrationsDir: string,
  migrationsTable: string,
) =>
  Effect.gen(function* () {
    const files = yield* listSqlFiles(migrationsDir);
    if (files.length > 0) {
      yield* applyMigrations({
        connectionUri,
        migrationsTable,
        migrationsFiles: files,
      });
    }
    const hashes: Record<string, string> = {};
    for (const file of files) hashes[file.id] = file.hash;
    return hashes;
  });

const runImports = (
  connectionUri: Redacted.Redacted<string>,
  importFiles: ReadonlyArray<string>,
  rootDir: string,
  previous: Record<string, string>,
) =>
  Effect.gen(function* () {
    const hashes: Record<string, string> = { ...previous };
    for (const filePath of importFiles) {
      const file = yield* readSqlFile(rootDir, filePath);
      if (previous[filePath] === file.hash) {
        hashes[filePath] = file.hash;
        continue;
      }
      yield* runSql(connectionUri, file.sql);
      hashes[filePath] = file.hash;
    }
    const tracked = new Set(importFiles);
    for (const key of Object.keys(hashes)) {
      if (!tracked.has(key)) delete hashes[key];
    }
    return hashes;
  });

const diffCheck = Effect.fn(function* (
  news: DatabaseProps,
  output: Database["Attributes"] | undefined,
) {
  if (!isResolved(news)) return undefined;
  if (news.migrationsDir) {
    const newHashes = yield* hashMigrations(news.migrationsDir);
    if (!recordsEqual(newHashes, output?.migrationsHashes ?? {})) {
      return { action: "update" } as const;
    }
    if (
      (news.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE) !==
      (output?.migrationsTable ?? DEFAULT_MIGRATIONS_TABLE)
    ) {
      return { action: "update" } as const;
    }
  }
  if (news.importFiles?.length) {
    const newHashes = yield* hashImports(news.importFiles, yield* rootDir);
    if (!recordsEqual(newHashes, output?.importHashes ?? {})) {
      return { action: "update" } as const;
    }
  }
  return undefined;
});

const reconcileAttributes = Effect.fn(function* (
  news: DatabaseProps,
  output: Database["Attributes"] | undefined,
  origin: PostgresOrigin,
) {
  const connectionUri = buildConnectionUri(origin);
  const redactedUri = Redacted.make(connectionUri);

  const migrationsTable =
    news.migrationsTable ??
    output?.migrationsTable ??
    DEFAULT_MIGRATIONS_TABLE;
  const migrationsHashes = news.migrationsDir
    ? yield* runMigrations(redactedUri, news.migrationsDir, migrationsTable)
    : (output?.migrationsHashes ?? {});
  const importHashes = news.importFiles?.length
    ? yield* runImports(
        redactedUri,
        news.importFiles,
        yield* rootDir,
        output?.importHashes ?? {},
      )
    : {};

  return {
    host: origin.host,
    port: origin.port,
    user: origin.user,
    password: origin.password,
    database: origin.database,
    connectionUri,
    origin,
    migrationsDir: news.migrationsDir,
    migrationsTable: news.migrationsDir ? migrationsTable : undefined,
    migrationsHashes,
    importHashes,
  } satisfies Database["Attributes"];
});

// --- Live Provider (deploy mode) ---

const PostgresLiveDatabaseProvider = Provider.succeed(Database, {
  list: () => Effect.succeed([]),
  read: Effect.fn(function* ({ output }) {
    return output ?? undefined;
  }),
  diff: Effect.fn(function* ({ news, output }) {
    return yield* diffCheck(news, output);
  }),
  reconcile: Effect.fn(function* ({ news, output }) {
    const origin = resolveLiveOrigin(news);
    return yield* reconcileAttributes(news, output, origin);
  }),
  delete: Effect.fn(function* () {}),
});

// --- Local Provider (dev mode) ---

const PostgresLocalDatabaseProvider = Provider.effect(
  Database,
  Effect.gen(function* () {
    const docker = yield* Docker;

    return Database.Provider.of({
      list: () => Effect.succeed([]),
      read: Effect.fn(function* ({ output }) {
        return output ?? undefined;
      }),
      diff: Effect.fn(function* ({ news, output }) {
        return yield* diffCheck(news, output);
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        const origin =
          news.dev && "docker" in news.dev && news.dev.docker
            ? yield* resolveDockerOrigin(id, news.dev.docker, news)
            : news.dev
              ? resolvePassthroughOrigin(news.dev, news)
              : resolveLiveOrigin(news);
        return yield* reconcileAttributes(news, output, origin);
      }),
      delete: Effect.fn(function* ({ id }) {
        const name = makeContainerName(id);
        yield* docker.container
          .stop(name)
          .pipe(
            Effect.andThen(() => docker.container.remove(name, true)),
            Effect.catchAll(() => Effect.void),
          );
      }),
    });
  }),
);

// --- Dual Provider ---

export const PostgresDatabaseProvider = () =>
  ProviderLayer.dual(Database, {
    live: () => PostgresLiveDatabaseProvider,
    local: () =>
      PostgresLocalDatabaseProvider.pipe(
        Layer.provide(DockerLive),
      ),
  });
