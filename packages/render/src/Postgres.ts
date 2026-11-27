import {
  diffMigrations,
  migrationsAttrs,
  migrationsInputOf,
  runMigrations,
  stampedOf,
  withPgExecutor,
  type MigrationsInput,
} from "@alchemy.run/sql/Migrations";
import { stripSslQueryParams } from "@alchemy.run/sql/PostgresDriver";
import { applySqlImports, hashImports } from "@alchemy.run/sql/SqlFile";
import * as RenderSdk from "@distilled.cloud/render";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { RenderDeployFailedError, RenderValidationError } from "./Errors.ts";
import * as Api from "./internal/Api.ts";
import { renderResourceLogs, renderResourceTail } from "./internal/Logs.ts";
import { pollUntil } from "./internal/Poll.ts";
import { toRedacted, unwrapSecret } from "./internal/Redacted.ts";
import { buildIpAllowListField, syncResourceLogStream } from "./internal/ServiceBase.ts";
import { parsePostgresOrigin, toPooledPostgresUrl, type PostgresOrigin } from "./PostgresOrigin.ts";
import type { Providers } from "./Providers.ts";
import type {
  CidrBlockAndDescription,
  DatabaseStatus,
  LogStreamOverrideAttributes,
  LogStreamOverrideInput,
  PostgresConnectionPool,
  PostgresExportInfo,
  PostgresPlan,
  PostgresRecoveryInfo,
  PostgresRestoreFrom,
  PostgresVersion,
  Region,
  SecretString,
} from "./Types.ts";

export interface PostgresReadReplicaInput {
  /** Display name of the read replica instance. */
  name: string;
  /** Optional log stream override scoped to this read replica. */
  logStreamOverride?: LogStreamOverrideInput;
}

export interface PostgresReadReplicaAttributes {
  /** Read replica identifier (`dpg-...`). */
  id: string;
  /** Replica display name. */
  name: string;
  /** Log stream override active on the replica, if configured. */
  logStreamOverride?: LogStreamOverrideAttributes;
}

export interface PostgresConnectionInfo {
  /** External TLS PostgreSQL connection string for connections outside Render. */
  externalConnectionString: Redacted.Redacted<string>;
  /** Internal private network PostgreSQL connection string for services on Render. */
  internalConnectionString: Redacted.Redacted<string>;
  /** PgBouncer-pooled internal connection string (`:6432`) when `connectionPool === "pgbouncer"`. */
  pooledInternalConnectionString?: Redacted.Redacted<string>;
  /** PgBouncer-pooled external TLS connection string (`:6432`) when `connectionPool === "pgbouncer"`. */
  pooledExternalConnectionString?: Redacted.Redacted<string>;
  /** Redacted PostgreSQL user password. */
  password: Redacted.Redacted<string>;
  /** Ready-to-run `psql` CLI command. */
  psqlCommand: Redacted.Redacted<string>;
}

export interface PostgresProps {
  /** Database instance name. If omitted, a deterministic physical name is generated. */
  name?: string;
  /** Optional Render workspace/owner ID. Defaults to the configured profile or the sole owner on `/owners`. */
  ownerId?: string;
  /** Optional Render project environment ID (`env-...`) to scope the database to. */
  environmentId?: string;
  /** Render Postgres plan (`"free"`, `"basic_256mb"`, `"basic_1gb"`, `"pro_4gb"`, `"starter"`, etc.). */
  plan?: PostgresPlan;
  /** PostgreSQL major version (`"11"` through `"18"`). Changing it replaces the database. */
  version?: PostgresVersion;
  /** Deployment region. Changing it replaces the database. */
  region?: Region;
  /** Initial SQL database name created on provisioning. Changing it replaces the database. */
  databaseName?: string;
  /** Primary SQL user created on provisioning. Changing it replaces the database. */
  databaseUser?: string;
  /** Allocated disk size in GiB (`1` or a positive multiple of `5`). */
  diskSizeGB?: number;
  /** Enable automatic disk scaling on paid plans. */
  enableDiskAutoscaling?: boolean;
  /** Enable high availability standby replication on paid plans. */
  enableHighAvailability?: boolean;
  /** PgBouncer connection pooling mode (`"pgbouncer"` or `"none"`). */
  connectionPool?: PostgresConnectionPool;
  /** Suspend (`true`) or resume (`false`) the Postgres database instance. */
  suspended?: boolean;
  /** Create this database as a point-in-time recovery clone of another Render Postgres instance. Changing it replaces the database. */
  restoreFrom?: PostgresRestoreFrom;
  /** IPv4 CIDR blocks permitted to connect externally. */
  ipAllowList?: CidrBlockAndDescription[];
  /** Read replica configurations attached to this primary database. */
  readReplicas?: PostgresReadReplicaInput[];
  /** Optional Datadog API key for monitoring integration (pass empty string to clear). */
  datadogApiKey?: SecretString;
  /** Optional Datadog site region (defaults to `"US1"`). */
  datadogSite?: string;
  /** Optional log stream override scoped to this database. */
  logStreamOverride?: LogStreamOverrideInput;
  /**
   * SQL migrations to apply after provisioning/updating (directory path,
   * `Drizzle.Schema` resource, or `{ dir, table? }`).
   */
  migrations?: MigrationsInput;
  /** Paths to additional `.sql` seed/setup files applied once per content hash change. */
  importFiles?: string[];
}

export interface PostgresAttributes {
  /** Postgres database ID (`dpg-...`). */
  id: string;
  /** Database display name. */
  name: string;
  /** Owner workspace ID. */
  ownerId: string;
  /** Associated Render environment ID, if any. */
  environmentId?: string;
  /** Instance plan slug. */
  plan: string;
  /** Deployment region. */
  region: string;
  /** PostgreSQL major version. */
  version: string;
  /** SQL database name. */
  databaseName: string;
  /** Primary SQL username. */
  databaseUser: string;
  /** Allocated disk size in GiB. */
  diskSizeGB?: number;
  /** Whether disk autoscaling is enabled. */
  diskAutoscalingEnabled: boolean;
  /** Whether high availability is enabled. */
  highAvailabilityEnabled: boolean;
  /** PgBouncer connection pooling setting (`"pgbouncer"` or `"none"`). */
  connectionPool: PostgresConnectionPool;
  /** Database lifecycle status. */
  status: DatabaseStatus;
  /** Database role (`"primary"` or `"replica"`). */
  role: string;
  /** Suspension status. */
  suspended: string;
  /** Render Dashboard URL. */
  dashboardUrl: string;
  /** IP allow list rules. */
  ipAllowList: CidrBlockAndDescription[];
  /** Reconciled read replicas. */
  readReplicas: PostgresReadReplicaAttributes[];
  /** Connection credentials & strings (redacted). */
  connectionInfo: PostgresConnectionInfo;
  /** Parsed external Postgres connection parameters (`scheme`, `host`, `port`, `database`, `user`, `password`). */
  origin: PostgresOrigin;
  /** Parsed external PgBouncer connection parameters when `connectionPool === "pgbouncer"`. */
  pooledOrigin?: PostgresOrigin;
  /** Point-in-time recovery availability status and window start timestamp, if available. */
  recovery?: PostgresRecoveryInfo;
  /** Log stream override active on the primary database, if any. */
  logStreamOverride?: LogStreamOverrideAttributes;
  /** Free-tier expiration timestamp, if applicable. */
  expiresAt?: string;
  /** Creation timestamp (ISO 8601). */
  createdAt: string;
  /** Last update timestamp (ISO 8601). */
  updatedAt: string;
  /** Applied migrations directory, if configured. */
  migrationsDir: string | undefined;
  /** Migrations bookkeeping table name, if configured. */
  migrationsTable: string | undefined;
  /** Content hashes of applied migration files. */
  migrationsHashes: Record<string, string>;
  /** Content hashes of applied SQL import files. */
  importHashes: Record<string, string>;
}

export interface PostgresLookup {
  /** Look up an existing Postgres database by ID (`dpg-...`). */
  id?: string;
  /** Look up an existing Postgres database by exact name. */
  name?: string;
  /** Optional owner ID override for name lookup. */
  ownerId?: string;
}

export type Postgres = Resource<
  "Render.Postgres",
  PostgresProps,
  PostgresAttributes,
  never,
  Providers,
  PostgresLookup
>;

/**
 * A managed Render PostgreSQL database with automated backups, high availability,
 * read replicas, and Alchemy SQL migration support.
 *
 * Connect from a Render service or foreign runtime via {@link ConnectPostgres}.
 *
 * **Example:** Postgres database with SQL migrations
 * ```typescript
 * const db = yield* Render.Postgres("MainDb", {
 *   name: "main-db",
 *   plan: "basic_256mb",
 *   region: "oregon",
 *   version: "16",
 *   environmentId: env.id,
 *   migrations: "./migrations",
 * });
 * ```
 *
 * @resource
 * @product Postgres
 * @category Storage & Databases
 */
export const Postgres = Resource<Postgres>("Render.Postgres");

const validateDiskSizeGB = (diskSizeGB: number | undefined) => {
  if (diskSizeGB === undefined) return Effect.void;
  if (
    diskSizeGB === 1 ||
    (Number.isInteger(diskSizeGB) && diskSizeGB > 0 && diskSizeGB % 5 === 0)
  ) {
    return Effect.void;
  }
  return Effect.fail(
    new RenderValidationError({
      field: "diskSizeGB",
      message: `Invalid Render Postgres diskSizeGB (${diskSizeGB}): must be 1 or a positive multiple of 5.`,
    }),
  );
};

const listAllPostgres = (params: { readonly ownerId?: string[]; readonly name?: string[] }) =>
  Api.paginateCursorList(
    (cursor) => RenderSdk.listPostgres({ ...params, cursor, limit: 100 }),
    (row) => row.postgres,
  );

const waitForPostgresAvailable = (postgresId: string) =>
  pollUntil({
    operation: "postgres provisioning",
    resourceId: postgresId,
    check: RenderSdk.getPostgres({ postgresId }),
    statusOf: (pg) => pg.status,
    failIf: (pg) => {
      if (pg.status === "unavailable" || pg.status === "recovery_failed") {
        return new RenderDeployFailedError({
          resourceType: "Render.Postgres",
          resourceId: postgresId,
          status: pg.status,
          message: `Render Postgres ${postgresId} entered terminal status "${pg.status}"`,
        });
      }
      return undefined;
    },
    isDone: (pg) => pg.status === "available",
  });

const hydratePostgres = (
  pg: RenderSdk.Postgres | RenderSdk.PostgresDetail,
  extraState?: {
    migrationsDir?: string | undefined;
    migrationsTable?: string | undefined;
    migrationsHashes?: Record<string, string>;
    importHashes?: Record<string, string>;
  },
) =>
  Effect.gen(function* () {
    const connInfo = yield* RenderSdk.getPostgresConnectionInfo({ postgresId: pg.id });
    const logStream = yield* Api.ignoreNotFound(
      RenderSdk.getResourceLogStream({ resourceId: pg.id }),
    );
    const recovery = yield* Api.ignoreNotFound(
      RenderSdk.getPostgresRecoveryInfo({ postgresId: pg.id }),
    );
    const replicaAttrs: PostgresReadReplicaAttributes[] = [];
    for (const replica of pg.readReplicas ?? []) {
      const rLog = yield* Api.ignoreNotFound(
        RenderSdk.getResourceLogStream({ resourceId: replica.id }),
      );
      replicaAttrs.push({
        id: replica.id,
        name: replica.name,
        logStreamOverride: rLog?.setting
          ? {
              resourceId: rLog.resourceId ?? replica.id,
              setting: rLog.setting,
              endpoint: rLog.endpoint,
            }
          : undefined,
      });
    }
    const connectionPool: PostgresConnectionPool =
      pg.connectionPool === "pgbouncer" ? "pgbouncer" : "none";
    const isPooled = connectionPool === "pgbouncer";
    const externalUrl = unwrapSecret(connInfo.externalConnectionString);
    const internalUrl = unwrapSecret(connInfo.internalConnectionString);
    const password = unwrapSecret(connInfo.password);
    const psqlCommand = unwrapSecret(connInfo.psqlCommand);
    const pooledExternal = isPooled ? toPooledPostgresUrl(externalUrl) : undefined;
    const pooledInternal = isPooled ? toPooledPostgresUrl(internalUrl) : undefined;
    return {
      id: pg.id,
      name: pg.name,
      ownerId: pg.owner.id,
      environmentId: pg.environmentId,
      plan: pg.plan,
      region: pg.region,
      version: pg.version,
      databaseName: pg.databaseName,
      databaseUser: pg.databaseUser,
      diskSizeGB: pg.diskSizeGB,
      diskAutoscalingEnabled: pg.diskAutoscalingEnabled,
      highAvailabilityEnabled: pg.highAvailabilityEnabled,
      connectionPool,
      status: pg.status,
      role: pg.role,
      suspended: pg.suspended,
      dashboardUrl: pg.dashboardUrl,
      ipAllowList: pg.ipAllowList ?? [],
      readReplicas: replicaAttrs,
      connectionInfo: {
        externalConnectionString: toRedacted(externalUrl),
        internalConnectionString: toRedacted(internalUrl),
        ...(pooledInternal !== undefined
          ? { pooledInternalConnectionString: toRedacted(pooledInternal) }
          : {}),
        ...(pooledExternal !== undefined
          ? { pooledExternalConnectionString: toRedacted(pooledExternal) }
          : {}),
        password: toRedacted(password),
        psqlCommand: toRedacted(psqlCommand),
      },
      origin: parsePostgresOrigin(externalUrl),
      ...(pooledExternal !== undefined
        ? { pooledOrigin: parsePostgresOrigin(pooledExternal) }
        : {}),
      ...(recovery !== undefined ? { recovery } : {}),
      logStreamOverride: logStream?.setting
        ? {
            resourceId: logStream.resourceId ?? pg.id,
            setting: logStream.setting,
            endpoint: logStream.endpoint,
          }
        : undefined,
      expiresAt: pg.expiresAt,
      createdAt: pg.createdAt,
      updatedAt: pg.updatedAt,
      migrationsDir: extraState?.migrationsDir,
      migrationsTable: extraState?.migrationsTable,
      migrationsHashes: extraState?.migrationsHashes ?? {},
      importHashes: extraState?.importHashes ?? {},
    } satisfies PostgresAttributes;
  });

/** List existing logical exports/backups for a Render Postgres database. */
export const listPostgresExports = (
  postgresId: string,
): Effect.Effect<
  PostgresExportInfo[],
  Effect.Error<ReturnType<typeof RenderSdk.listPostgresExport>>,
  Effect.Services<ReturnType<typeof RenderSdk.listPostgresExport>>
> => RenderSdk.listPostgresExport({ postgresId });

/** Trigger a new logical database export on a Render Postgres database. */
export const createPostgresExport = (
  postgresId: string,
): Effect.Effect<
  void,
  Effect.Error<ReturnType<typeof RenderSdk.createPostgresExport>>,
  Effect.Services<ReturnType<typeof RenderSdk.createPostgresExport>>
> => RenderSdk.createPostgresExport({ postgresId }).pipe(Effect.asVoid);

const syncReplicaLogStreams = (
  pg: RenderSdk.Postgres | RenderSdk.PostgresDetail,
  desiredReplicas: ReadonlyArray<PostgresReadReplicaInput> | undefined,
  existingReplicas: ReadonlyArray<PostgresReadReplicaAttributes>,
) =>
  Effect.gen(function* () {
    const desiredByName = new Map(
      (desiredReplicas ?? []).map((r) => [r.name, r.logStreamOverride]),
    );
    const existingById = new Map(existingReplicas.map((r) => [r.id, r.logStreamOverride]));
    for (const replica of pg.readReplicas ?? []) {
      const desiredLog = desiredByName.get(replica.name);
      const currentLog: RenderSdk.GetResourceLogStreamResponse | undefined = existingById.get(
        replica.id,
      );
      yield* syncResourceLogStream(replica.id, currentLog, desiredLog);
    }
  });

const TRANSIENT_PG_CONNECT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "57P03",
  "08001",
  "08006",
]);

const isTransientPgConnectError = (cause: unknown): boolean => {
  if (typeof cause !== "object" || cause === null) return false;
  const { code, message } = cause as { code?: unknown; message?: unknown };
  if (typeof code === "string" && TRANSIENT_PG_CONNECT_CODES.has(code)) {
    return true;
  }
  if (typeof message === "string") {
    const lower = message.toLowerCase();
    return (
      lower.includes("service temporarily unavailable") ||
      lower.includes("database system is starting up") ||
      lower.includes("connection terminated unexpectedly")
    );
  }
  return false;
};

export const PostgresProvider = () =>
  Provider.effect(
    Postgres,
    Effect.succeed({
      stables: ["id", "databaseName", "databaseUser", "version", "region"],
      nuke: {
        dependsOn: ["Render.Environment", "Render.Project"],
      },
      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        if (yield* diffMigrations({ news, output })) {
          return { action: "update" } as const;
        }
        const deleteFirst =
          typeof news.name === "string" && news.name === (output?.name ?? olds.name);

        if (!deepEqual(news.restoreFrom, olds.restoreFrom)) {
          return { action: "replace", deleteFirst } as const;
        }

        const targetRegion = news.region ?? olds.region;
        const prevRegion = olds.region ?? output?.region;
        if (targetRegion !== undefined && prevRegion !== undefined && targetRegion !== prevRegion) {
          return { action: "replace", deleteFirst } as const;
        }
        const targetVersion = news.version ?? olds.version;
        const prevVersion = olds.version ?? output?.version;
        if (
          targetVersion !== undefined &&
          prevVersion !== undefined &&
          targetVersion !== prevVersion
        ) {
          return { action: "replace", deleteFirst } as const;
        }
        if (
          news.databaseName !== undefined &&
          (olds.databaseName ?? output?.databaseName) !== undefined &&
          news.databaseName !== (olds.databaseName ?? output?.databaseName)
        ) {
          return { action: "replace", deleteFirst } as const;
        }
        if (
          news.databaseUser !== undefined &&
          (olds.databaseUser ?? output?.databaseUser) !== undefined &&
          news.databaseUser !== (olds.databaseUser ?? output?.databaseUser)
        ) {
          return { action: "replace", deleteFirst } as const;
        }
        const nextImportHashes =
          Array.isArray(news.importFiles) && news.importFiles.length > 0
            ? yield* hashImports(news.importFiles, process.cwd())
            : {};
        if (!deepEqual(nextImportHashes, output?.importHashes ?? {})) {
          return { action: "update" } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ id, olds, output, previous }) {
        if (output?.id) {
          const pg = yield* Api.ignoreNotFound(RenderSdk.getPostgres({ postgresId: output.id }));
          if (!pg) return undefined;
          return yield* hydratePostgres(pg, {
            migrationsDir: output.migrationsDir,
            migrationsTable: output.migrationsTable,
            migrationsHashes: output.migrationsHashes ?? {},
            importHashes: output.importHashes ?? {},
          });
        }
        const explicitName =
          typeof olds?.name === "string" && olds.name.length > 0 ? olds.name : undefined;
        const explicitOwnerId =
          typeof olds?.ownerId === "string" && olds.ownerId.length > 0 ? olds.ownerId : undefined;
        const desiredName = explicitName ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const ownerId = yield* Api.resolveOwnerId(explicitOwnerId);
        const all = yield* listAllPostgres({ ownerId: [ownerId], name: [desiredName] });
        const matched = all.find((p) => p.name === desiredName);
        if (!matched) return undefined;
        const attrs = yield* hydratePostgres(matched);
        return explicitName === undefined || matched.id === previous?.id ? attrs : Unowned(attrs);
      }),
      lookup: Effect.fn(function* (props) {
        if (props.id) {
          const pg = yield* Api.ignoreNotFound(RenderSdk.getPostgres({ postgresId: props.id }));
          return pg ? yield* hydratePostgres(pg) : undefined;
        }
        if (props.name) {
          const ownerId = yield* Api.resolveOwnerId(props.ownerId);
          const all = yield* listAllPostgres({ ownerId: [ownerId], name: [props.name] });
          const matched = all.find((p) => p.name === props.name);
          return matched ? yield* hydratePostgres(matched) : undefined;
        }
        return undefined;
      }),
      list: Effect.fn(function* () {
        const ownerId = yield* Api.resolveOwnerId();
        const all = yield* listAllPostgres({ ownerId: [ownerId] });
        return yield* Effect.forEach(all, (pg) => hydratePostgres(pg));
      }),
      reconcile: Effect.fn(function* ({ id, news, olds, output }) {
        yield* validateDiskSizeGB(news.diskSizeGB);
        const desiredName = news.name ?? (yield* createPhysicalName({ id, maxLength: 64 }));
        const existing = output?.id
          ? yield* Api.ignoreNotFound(RenderSdk.getPostgres({ postgresId: output.id }))
          : undefined;

        let latestPg: RenderSdk.PostgresDetail;
        if (!existing) {
          if (news.restoreFrom) {
            const restored = yield* RenderSdk.recoverPostgres({
              postgresId: news.restoreFrom.sourcePostgresId,
              restoreName: desiredName,
              restoreTime: news.restoreFrom.restoreTime,
              ...(news.plan !== undefined ? { plan: news.plan } : {}),
            });
            latestPg = yield* waitForPostgresAvailable(restored.id);
            const hasPostRestorePatch =
              news.connectionPool !== undefined ||
              news.ipAllowList !== undefined ||
              news.enableDiskAutoscaling !== undefined ||
              news.enableHighAvailability !== undefined;
            if (hasPostRestorePatch) {
              yield* RenderSdk.updatePostgres({
                postgresId: latestPg.id,
                ...(news.connectionPool !== undefined
                  ? { connectionPool: news.connectionPool }
                  : {}),
                ...(news.enableDiskAutoscaling !== undefined
                  ? { enableDiskAutoscaling: news.enableDiskAutoscaling }
                  : {}),
                ...(news.enableHighAvailability !== undefined
                  ? { enableHighAvailability: news.enableHighAvailability }
                  : {}),
                ...(news.ipAllowList !== undefined ? { ipAllowList: news.ipAllowList } : {}),
              });
              latestPg = yield* waitForPostgresAvailable(latestPg.id);
            }
            if (news.environmentId !== undefined) {
              yield* Api.syncResourceEnvironment(
                latestPg.id,
                latestPg.environmentId,
                news.environmentId,
              );
              latestPg = yield* RenderSdk.getPostgres({ postgresId: latestPg.id });
            }
          } else {
            const ownerId = yield* Api.resolveOwnerId(news.ownerId);
            const created = yield* RenderSdk.createPostgres({
              name: desiredName,
              ownerId,
              plan: news.plan ?? "free",
              version: news.version ?? "16",
              ...(news.region !== undefined ? { region: news.region } : {}),
              ...(news.environmentId !== undefined ? { environmentId: news.environmentId } : {}),
              ...(news.databaseName !== undefined ? { databaseName: news.databaseName } : {}),
              ...(news.databaseUser !== undefined ? { databaseUser: news.databaseUser } : {}),
              ...(news.diskSizeGB !== undefined ? { diskSizeGB: news.diskSizeGB } : {}),
              ...(news.enableDiskAutoscaling !== undefined
                ? { enableDiskAutoscaling: news.enableDiskAutoscaling }
                : {}),
              ...(news.enableHighAvailability !== undefined
                ? { enableHighAvailability: news.enableHighAvailability }
                : {}),
              ...(news.connectionPool !== undefined ? { connectionPool: news.connectionPool } : {}),
              ...(news.ipAllowList !== undefined ? { ipAllowList: news.ipAllowList } : {}),
              ...(news.readReplicas !== undefined
                ? {
                    readReplicas: news.readReplicas.map((r) => ({
                      name: r.name,
                    })),
                  }
                : {}),
              ...(news.datadogApiKey !== undefined ? { datadogAPIKey: news.datadogApiKey } : {}),
              ...(news.datadogSite !== undefined ? { datadogSite: news.datadogSite } : {}),
            });
            latestPg = yield* waitForPostgresAvailable(created.id);
          }

          if (news.logStreamOverride) {
            yield* syncResourceLogStream(latestPg.id, undefined, news.logStreamOverride);
          }
          yield* syncReplicaLogStreams(latestPg, news.readReplicas, []);
        } else {
          const ipAllowList = buildIpAllowListField(news.ipAllowList, olds?.ipAllowList);

          const updated = yield* RenderSdk.updatePostgres({
            postgresId: existing.id,
            name: desiredName,
            ...(news.plan !== undefined ? { plan: news.plan } : {}),
            ...(news.diskSizeGB !== undefined ? { diskSizeGB: news.diskSizeGB } : {}),
            ...(news.enableDiskAutoscaling !== undefined
              ? { enableDiskAutoscaling: news.enableDiskAutoscaling }
              : {}),
            ...(news.enableHighAvailability !== undefined
              ? { enableHighAvailability: news.enableHighAvailability }
              : {}),
            ...(news.connectionPool !== undefined ? { connectionPool: news.connectionPool } : {}),
            ...(ipAllowList !== undefined ? { ipAllowList } : {}),
            ...(news.readReplicas !== undefined
              ? {
                  readReplicas: news.readReplicas.map((r) => ({
                    name: r.name,
                  })),
                }
              : {}),
            ...(news.datadogApiKey !== undefined ? { datadogAPIKey: news.datadogApiKey } : {}),
            ...(news.datadogSite !== undefined ? { datadogSite: news.datadogSite } : {}),
          });

          yield* Api.syncResourceEnvironment(
            existing.id,
            updated.environmentId ?? existing.environmentId,
            news.environmentId,
          );

          const currentLog = yield* Api.ignoreNotFound(
            RenderSdk.getResourceLogStream({ resourceId: existing.id }),
          );
          yield* syncResourceLogStream(existing.id, currentLog, news.logStreamOverride);
          yield* syncReplicaLogStreams(updated, news.readReplicas, output?.readReplicas ?? []);
          latestPg =
            updated.status === "creating" || updated.status === "updating_instance"
              ? yield* waitForPostgresAvailable(updated.id)
              : yield* RenderSdk.getPostgres({ postgresId: updated.id });
        }

        if (news.suspended === true && latestPg.suspended !== "suspended") {
          yield* RenderSdk.suspendPostgres({ postgresId: latestPg.id });
          latestPg = yield* RenderSdk.getPostgres({ postgresId: latestPg.id });
        } else if (news.suspended === false && latestPg.suspended === "suspended") {
          yield* RenderSdk.resumePostgres({ postgresId: latestPg.id });
          latestPg = yield* waitForPostgresAvailable(latestPg.id);
        }

        const migInput = migrationsInputOf(news);
        const connInfo = yield* RenderSdk.getPostgresConnectionInfo({ postgresId: latestPg.id });
        const pgConfig = {
          connectionString: stripSslQueryParams(unwrapSecret(connInfo.externalConnectionString)),
          ssl: { rejectUnauthorized: false },
        };
        const pgConnectOptions = {
          retryConnect: {
            while: isTransientPgConnectError,
            times: 15,
            interval: "2 seconds" as const,
          },
        };

        const migRun =
          migInput && latestPg.suspended !== "suspended"
            ? yield* runMigrations({
                input: migInput,
                stamped: stampedOf(output),
                withExecutor: (apply) => withPgExecutor(pgConfig, apply, pgConnectOptions),
              })
            : undefined;

        const importHashes =
          latestPg.suspended !== "suspended" &&
          ((news.importFiles?.length ?? 0) > 0 ||
            Object.keys(output?.importHashes ?? {}).length > 0)
            ? yield* applySqlImports({
                importFiles: news.importFiles,
                rootDir: process.cwd(),
                previous: output?.importHashes,
                apply: (file) =>
                  withPgExecutor(
                    pgConfig,
                    (executor) => executor.query(file.sql).pipe(Effect.asVoid),
                    pgConnectOptions,
                  ),
              })
            : (output?.importHashes ?? {});

        return yield* hydratePostgres(latestPg, {
          ...migrationsAttrs({ input: migInput, run: migRun, output }),
          importHashes,
        });
      }),
      delete: Effect.fn(function* ({ output }) {
        if (!output?.id) return;
        yield* Api.deleteIdempotent(RenderSdk.deletePostgres({ postgresId: output.id }));
      }),
      logs: Effect.fn(function* ({ output, options }) {
        return yield* renderResourceLogs({
          ownerId: output.ownerId,
          resourceId: output.id,
          options,
        });
      }),
      tail: ({ output }) =>
        renderResourceTail({
          ownerId: output.ownerId,
          resourceId: output.id,
        }),
    }),
  );
