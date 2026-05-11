import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../../../Diff.ts";
import { createPhysicalName } from "../../../PhysicalName.ts";
import {
  applyMigrations,
  listSqlFiles,
  type PostgresOrigin,
  readSqlFile,
  runSql,
} from "../../../Postgres/index.ts";
import * as Provider from "../../../Provider.ts";
import { Resource } from "../../../Resource.ts";
import type { Providers } from "../../Providers.ts";
import * as api from "../api.ts";

const DEFAULT_MIGRATIONS_TABLE = "vultr_migrations";
const DEFAULT_PG_VERSION = "16";

/**
 * Vultr Managed Postgres `database_engine_version` values. Vultr only
 * accepts major-version strings. Non-exhaustive — Vultr adds/removes
 * versions over time.
 *
 * @see https://api.vultr.com/v2/databases/plans?engine=pg
 */
export type PostgresVersion = "13" | "14" | "15" | "16" | "17" | (string & {});

/**
 * Database plan slug. Cheapest pg-capable plan is the shared-CPU
 * hobbyist tier `vultr-dbaas-hobbyist-cc-1-25-1` ($15/mo, 1GB RAM,
 * 25GB disk). Non-exhaustive.
 *
 * @see https://api.vultr.com/v2/databases/plans?engine=pg
 */
export type DatabasePlan =
  | "vultr-dbaas-hobbyist-cc-1-25-1"
  | "vultr-dbaas-startup-cc-1-55-2"
  | "vultr-dbaas-business-cc-2-80-2"
  | (string & {});

/**
 * Region slug for managed databases. Vultr uses **uppercase** region
 * codes (`"EWR"`) on the managed-databases endpoint and lowercase
 * (`"ewr"`) on the compute endpoint — be careful copy-pasting between
 * the two.
 */
export type DatabaseRegion =
  | "EWR"
  | "ORD"
  | "DFW"
  | "SEA"
  | "LAX"
  | "ATL"
  | "AMS"
  | "LHR"
  | "FRA"
  | "SJC"
  | "SYD"
  | "NRT"
  | "SGP"
  | (string & {});

export type MaintenanceDow =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export type PostgresProps = {
  /**
   * Postgres major version. Cannot be changed in place after creation —
   * Vultr does not support in-place major upgrades, so a change here
   * triggers a replace.
   *
   * @default "16"
   */
  version?: PostgresVersion;
  /**
   * Region the cluster runs in (uppercase, e.g. `"EWR"`). Immutable.
   */
  region: DatabaseRegion;
  /**
   * Plan slug. Treated as immutable — Vultr's PATCH supports plan
   * resize on some tiers, but in practice it can leave the cluster in
   * a degraded state for several minutes; a fresh cluster is safer.
   */
  plan: DatabasePlan;
  /**
   * Human-readable label shown in the Vultr console. If omitted, a
   * label is generated from `${stack}-${id}-${stage}`. Mutable.
   */
  label?: string;
  /**
   * Vultr "tag" (single string, **not** an array, unlike compute
   * instances). Mutable.
   */
  tag?: string;
  /**
   * VPC ID to attach the cluster to. Immutable.
   */
  vpcId?: string;
  /**
   * Allow-list of IPv4 CIDRs that may reach the public endpoint.
   * Mutable.
   */
  trustedIps?: string[];
  /**
   * Override the auto-generated admin password. Mutable.
   */
  password?: Redacted.Redacted<string>;
  /**
   * Day of week for the weekly maintenance window. Mutable.
   */
  maintenanceDow?: MaintenanceDow;
  /**
   * Maintenance window start time, 24h `HH:MM` UTC. Mutable.
   */
  maintenanceTime?: string;
  /**
   * UTC hour (0–23) for daily backups. Mutable.
   */
  backupHour?: string;
  /**
   * UTC minute (0–59) inside `backupHour`. Mutable.
   */
  backupMinute?: string;
  /**
   * Cluster time zone (TZ database format, e.g. `"Europe/Berlin"`).
   * Mutable.
   */
  clusterTimeZone?: string;
  /**
   * Additional disk in GB on top of the plan's base disk. Resizes
   * online. Mutable.
   */
  planDisk?: number;
  /**
   * Number of standby read replicas to provision alongside the
   * primary. Mutable.
   */
  planReplicas?: number;
  /**
   * Directory containing `.sql` migration files. Files are sorted by
   * their numeric prefix (e.g. `0001_init.sql`) and applied
   * in-transaction against the default database after the cluster
   * reaches `running`.
   */
  migrationsDir?: string;
  /**
   * Name of the bookkeeping table for tracking applied migrations.
   *
   * @default "vultr_migrations"
   */
  migrationsTable?: string;
  /**
   * Paths to additional `.sql` files run *after* migrations. Each is
   * content-hashed; only files whose contents change are re-applied.
   */
  importFiles?: string[];
};

export type PostgresAttrs = {
  databaseId: string;
  label: string;
  region: DatabaseRegion;
  plan: DatabasePlan;
  version: PostgresVersion;
  status: api.DatabaseStatus;
  host: string;
  publicHost: string | undefined;
  port: number;
  /** Default admin user (Vultr names it `vultradmin`). */
  user: string;
  /** Admin password — captured at create-time and on each reconcile. */
  password: Redacted.Redacted<string>;
  /** Default logical database (Vultr names it `defaultdb`). */
  databaseName: string;
  /** Postgres connection URI for the default DB + admin user. */
  connectionUri: Redacted.Redacted<string>;
  /**
   * Parsed connection components ready to feed Cloudflare.Hyperdrive's
   * `origin` prop or anywhere else expecting a structured Postgres
   * descriptor.
   */
  origin: PostgresOrigin;
  vpcId: string | undefined;
  trustedIps: string[];
  maintenanceDow: string;
  maintenanceTime: string;
  backupHour: string;
  backupMinute: string;
  clusterTimeZone: string;
  planDisk: number;
  planReplicas: number;
  latestBackup: string;
  dateCreated: string;
  migrationsDir: string | undefined;
  migrationsTable: string | undefined;
  migrationsHashes: Record<string, string>;
  importHashes: Record<string, string>;
};

export type Postgres = Resource<
  "Vultr.Database.Postgres",
  PostgresProps,
  PostgresAttrs,
  never,
  Providers
>;

/**
 * A Vultr Managed Postgres cluster.
 *
 * Provisioning a cluster takes several minutes (3–6 min for shared-CPU
 * hobbyist, 8–15 min for HA tiers with `planReplicas ≥ 1`). The
 * provider polls until `status === "running"` before returning.
 *
 * @section Creating a Cluster
 * @example Cheapest hobbyist box
 * ```typescript
 * const db = yield* Vultr.Database.Postgres("app-db", {
 *   region: "EWR",
 *   plan: "vultr-dbaas-hobbyist-cc-1-25-1",
 * });
 * ```
 *
 * @example Production tier with extra disk and a read standby
 * ```typescript
 * const db = yield* Vultr.Database.Postgres("app-db", {
 *   region: "EWR",
 *   plan: "vultr-dbaas-business-cc-2-80-2",
 *   version: "16",
 *   planDisk: 50,
 *   planReplicas: 1,
 *   trustedIps: ["203.0.113.0/24"],
 * });
 * ```
 *
 * @section Migrations and seed data
 * @example Apply migrations and seed files
 * ```typescript
 * const db = yield* Vultr.Database.Postgres("app-db", {
 *   region: "EWR",
 *   plan: "vultr-dbaas-hobbyist-cc-1-25-1",
 *   migrationsDir: "./migrations",
 *   importFiles: ["./seed/users.sql"],
 * });
 * ```
 *
 * @section Wiring into Cloudflare Hyperdrive
 * @example
 * ```typescript
 * const db = yield* Vultr.Database.Postgres("app-db", { region: "EWR", plan: "..." });
 * const hd = yield* Cloudflare.Hyperdrive("app-hd", { origin: db.origin });
 * ```
 *
 * @see https://www.vultr.com/api/#tag/managed-databases
 */
export const Postgres = Resource<Postgres>("Vultr.Database.Postgres");

const defaultLabel = (id: string) => createPhysicalName({ id });

const buildOrigin = (info: api.VultrDatabaseInfo): PostgresOrigin => ({
  scheme: "postgres",
  host: info.host,
  port: Number(info.port),
  database: info.dbname,
  user: info.user,
  password: Redacted.make(info.password),
});

const buildConnectionUri = (info: api.VultrDatabaseInfo) => {
  const url = new URL(`postgres://${info.host}:${info.port}/${info.dbname}`);
  url.username = encodeURIComponent(info.user);
  url.password = encodeURIComponent(info.password);
  url.searchParams.set("sslmode", "require");
  return url.toString();
};

const toAttrs = (
  info: api.VultrDatabaseInfo,
  migrationsDir: string | undefined,
  migrationsTable: string | undefined,
  migrationsHashes: Record<string, string>,
  importHashes: Record<string, string>,
): PostgresAttrs => ({
  databaseId: info.id,
  label: info.label,
  region: info.region,
  plan: info.plan,
  version: info.database_engine_version,
  status: info.status,
  host: info.host,
  publicHost: info.public_host || undefined,
  port: Number(info.port),
  user: info.user,
  password: Redacted.make(info.password),
  databaseName: info.dbname,
  connectionUri: Redacted.make(buildConnectionUri(info)),
  origin: buildOrigin(info),
  vpcId: info.vpc_id || undefined,
  trustedIps: info.trusted_ips ?? [],
  maintenanceDow: info.maintenance_dow,
  maintenanceTime: info.maintenance_time,
  backupHour: info.backup_hour,
  backupMinute: info.backup_minute,
  clusterTimeZone: info.cluster_time_zone,
  planDisk: info.plan_disk,
  planReplicas: info.plan_replicas,
  latestBackup: info.latest_backup,
  dateCreated: info.date_created,
  migrationsDir,
  migrationsTable,
  migrationsHashes,
  importHashes,
});

const recordsEqual = (
  a: Record<string, string>,
  b: Record<string, string>,
): boolean => {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
};

const hashMigrations = (migrationsDir: string) =>
  listSqlFiles(migrationsDir).pipe(
    Effect.map((files) => {
      const out: Record<string, string> = {};
      for (const f of files) out[f.id] = f.hash;
      return out;
    }),
  );

const hashImports = (importFiles: ReadonlyArray<string>, rootDir: string) =>
  Effect.gen(function* () {
    const out: Record<string, string> = {};
    for (const filePath of importFiles) {
      const f = yield* readSqlFile(rootDir, filePath);
      out[filePath] = f.hash;
    }
    return out;
  });

const runMigrationsForCluster = (
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

const runImportsForCluster = (
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

export const PostgresProvider = () =>
  Provider.effect(
    Postgres,
    Effect.gen(function* () {
      const rootDir = yield* Effect.sync(() => process.cwd());
      return {
        stables: ["databaseId", "region", "version"],

        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return undefined;
          const o = olds ?? ({} as Partial<PostgresProps>);

          // Immutables → replace.
          if (
            news.region !== (output?.region ?? o.region) ||
            (news.version ?? DEFAULT_PG_VERSION) !==
              (output?.version ?? o.version ?? DEFAULT_PG_VERSION) ||
            news.plan !== (output?.plan ?? o.plan) ||
            (news.vpcId ?? "") !== (output?.vpcId ?? o.vpcId ?? "")
          ) {
            return { action: "replace" } as const;
          }

          // Migration / seed drift → update.
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
            const newHashes = yield* hashImports(news.importFiles, rootDir);
            if (!recordsEqual(newHashes, output?.importHashes ?? {})) {
              return { action: "update" } as const;
            }
          }

          // label is irrelevant to the diff narrative (no fingerprint use).
          // Engine's default compare handles other mutable scalars.
          void id;
          return undefined;
        }),

        read: Effect.fn(function* ({ id, output, olds }) {
          // Happy path: state has the cluster ID, fetch it directly.
          if (output?.databaseId) {
            return yield* api.getDatabase(output.databaseId).pipe(
              Effect.map(({ database }) =>
                toAttrs(
                  database,
                  output.migrationsDir,
                  output.migrationsTable,
                  output.migrationsHashes,
                  output.importHashes,
                ),
              ),
              Effect.catchTag("DatabaseNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          }
          // Recovery path: state lost / first reconcile after an aborted
          // create. Vultr's `tag` field is a single string so we can't
          // brand with multiple alchemy tags like we do for Compute.
          // Instance — instead we look up by the deterministic label
          // (`${stack}-${id}-${stage}-<hash>` from createPhysicalName).
          // The hash is derived from the engine's stable per-resource
          // instanceId, so it survives state loss as long as the
          // .alchemy state file's `instanceId` field is preserved.
          const expected = olds?.label ?? (yield* defaultLabel(id));
          const { databases } = yield* api.listDatabases({ label: expected });
          const adopted = databases.find((d) => d.label === expected);
          if (!adopted) return undefined;
          return toAttrs(
            adopted,
            olds?.migrationsDir,
            olds?.migrationsTable,
            {},
            {},
          );
        }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const label = news.label ?? (yield* defaultLabel(id));

          // ── Observe / ensure ──────────────────────────────────────
          let info: api.VultrDatabaseInfo | undefined = output?.databaseId
            ? yield* api.getDatabase(output.databaseId).pipe(
                Effect.map(({ database }) => database),
                Effect.catchTag("DatabaseNotFound", () =>
                  Effect.succeed(
                    undefined as api.VultrDatabaseInfo | undefined,
                  ),
                ),
              )
            : undefined;

          if (!info) {
            const created = yield* api.createDatabase({
              database_engine: "pg",
              database_engine_version: news.version ?? DEFAULT_PG_VERSION,
              region: news.region,
              plan: news.plan,
              label,
              tag: news.tag,
              vpc_id: news.vpcId,
              trusted_ips: news.trustedIps,
              maintenance_dow: news.maintenanceDow,
              maintenance_time: news.maintenanceTime,
              backup_hour: news.backupHour,
              backup_minute: news.backupMinute,
              cluster_time_zone: news.clusterTimeZone,
              password: news.password
                ? Redacted.value(news.password)
                : undefined,
              plan_disk: news.planDisk,
              plan_replicas: news.planReplicas,
            });
            info = yield* api.waitForRunning(created.database.id);
          }

          // ── Sync mutable scalars ──────────────────────────────────
          const updates: api.UpdateDatabaseInput = {};
          if (info.label !== label) updates.label = label;
          if ((info.tag ?? "") !== (news.tag ?? ""))
            updates.tag = news.tag ?? "";
          if (
            news.trustedIps !== undefined &&
            JSON.stringify([...(info.trusted_ips ?? [])].sort()) !==
              JSON.stringify([...news.trustedIps].sort())
          ) {
            updates.trusted_ips = news.trustedIps;
          }
          if (
            news.maintenanceDow !== undefined &&
            info.maintenance_dow !== news.maintenanceDow
          )
            updates.maintenance_dow = news.maintenanceDow;
          if (
            news.maintenanceTime !== undefined &&
            info.maintenance_time !== news.maintenanceTime
          )
            updates.maintenance_time = news.maintenanceTime;
          if (
            news.backupHour !== undefined &&
            info.backup_hour !== news.backupHour
          )
            updates.backup_hour = news.backupHour;
          if (
            news.backupMinute !== undefined &&
            info.backup_minute !== news.backupMinute
          )
            updates.backup_minute = news.backupMinute;
          if (
            news.clusterTimeZone !== undefined &&
            info.cluster_time_zone !== news.clusterTimeZone
          )
            updates.cluster_time_zone = news.clusterTimeZone;
          if (news.planDisk !== undefined && info.plan_disk !== news.planDisk)
            updates.plan_disk = news.planDisk;
          if (
            news.planReplicas !== undefined &&
            info.plan_replicas !== news.planReplicas
          )
            updates.plan_replicas = news.planReplicas;

          if (Object.keys(updates).length > 0) {
            const updated = yield* api.updateDatabase(info.id, updates);
            info = updated.database;
            // plan_replicas resize re-enters `rebuilding` — poll again.
            if (info.status.toLowerCase() !== "running") {
              info = yield* api.waitForRunning(info.id);
            }
          }

          // ── Migrations + imports ──────────────────────────────────
          const connectionUri = Redacted.make(buildConnectionUri(info));
          const migrationsTable =
            news.migrationsTable ??
            output?.migrationsTable ??
            DEFAULT_MIGRATIONS_TABLE;
          const migrationsHashes = news.migrationsDir
            ? yield* runMigrationsForCluster(
                connectionUri,
                news.migrationsDir,
                migrationsTable,
              )
            : (output?.migrationsHashes ?? {});
          const importHashes = news.importFiles?.length
            ? yield* runImportsForCluster(
                connectionUri,
                news.importFiles,
                rootDir,
                output?.importHashes ?? {},
              )
            : {};

          return toAttrs(
            info,
            news.migrationsDir,
            news.migrationsDir ? migrationsTable : undefined,
            migrationsHashes,
            importHashes,
          );
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* api.deleteDatabase(output.databaseId);
        }),
      };
    }),
  );
