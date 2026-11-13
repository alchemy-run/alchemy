import { createHash } from "node:crypto";
import {
  diffMigrations,
  type MigrationsInput,
  migrationsAttrs,
  migrationsInputOf,
  runMigrations,
  stampedOf,
  withPgExecutor,
} from "@alchemy.run/sql/Migrations";
import * as postgres from "@distilled.cloud/clickhouse-cloud/postgres";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import { Resource } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { FeatureUnavailable, MissingId } from "../Errors.ts";
import {
  hasOwnerTags,
  INSTANCE_TAG,
  isAlchemyTagged,
  ownerTags,
  physicalName,
} from "../internal/Names.ts";
import { pollUntil } from "../internal/Wait.ts";
import type { Providers } from "../Providers.ts";

/** One IPv4 rule of the access list. */
export interface PostgresIpAccessEntry {
  /** IPv4 address or CIDR. */
  source: string;
  /** `"5432"` (Postgres), `"6432"` (PgBouncer) or a range such as `"5432..6432"`. */
  portRange: string;
  /** What the rule is for. */
  description?: string;
}

/** A point-in-time restore of another Postgres service. */
export interface PostgresRestoreFrom {
  /** ID of the service to restore. */
  postgresId: string;
  /** Point in time, ISO 8601, between the source's `earliestRestoreTime` and now. */
  target: string;
}

export interface ServiceProps {
  /**
   * Service name; the host name and certificates follow it. If omitted, a
   * unique lowercase name is generated from the stack, stage and logical
   * ID. Changing it renames the service in place and moves it to a new
   * host name, which can take many minutes to resolve and to present a
   * certificate for it (live: over ten minutes once); with `migrations`,
   * deploy waits up to ten minutes for it.
   */
  name?: string;
  /** `aws` or `gcp`. Changing it replaces the service. */
  provider?: "aws" | "gcp";
  /** Region, e.g. `us-east-1`. Changing it replaces the service. */
  region?: string;
  /** Postgres major version. Changing it replaces the service. */
  postgresVersion?: "17" | "18";
  /** VM size, e.g. `r6gd.medium` (AWS) or `c4-standard-2` (GCP). Not used with `replicaOf`/`restoreFrom` (inherited). */
  size?: postgres.PgSize | (string & {});
  /** High availability: `none`, `async` (one standby) or `sync`. */
  haType?: "none" | "async" | "sync";
  /** Hot standbys; defaults follow `haType`. */
  standbyCount?: 0 | 1 | 2;
  /**
   * IPv4 rules allowed to connect. Omit to allow every address on 5432 and
   * 6432; `[]` blocks public access. Alchemy converges to exactly these.
   */
  ipAccessList?: PostgresIpAccessEntry[];
  /** Tags; keys starting with `chc_` are reserved. Alchemy adds its ownership tags. */
  tags?: Record<string, string>;
  /**
   * When true, the service cannot be deleted: destroy fails until it is
   * turned off. ClickHouse enables it per organization; elsewhere `true`
   * fails with `DeletionProtectionNotEnabled`.
   * @default false
   */
  deletionProtection?: boolean;
  /** `postgresql.conf` settings, e.g. `{ work_mem: "64MB" }`. Removed keys go back to defaults. */
  pgConfig?: Record<string, string | number>;
  /** PgBouncer settings, e.g. `{ pool_mode: "transaction" }`. */
  pgBouncerConfig?: Record<string, string>;
  /**
   * Superuser password. Write-only: changed when the value changes. If
   * omitted, the service keeps the password ClickHouse generated.
   * ClickHouse applies a new password a few seconds after the deploy
   * sets it, and refuses the old one at once; `migrations` wait for it.
   */
  password?: Redacted.Redacted<string>;
  /**
   * Make this service a read replica of another one. Removing it promotes
   * the replica in place; setting or changing it replaces the service.
   */
  replicaOf?: string;
  /**
   * Create the service as a point-in-time restore of another one. Only read
   * at creation: changing it replaces the service, discarding its data.
   */
  restoreFrom?: PostgresRestoreFrom;
  /**
   * SQL migrations to apply as the superuser, over TLS, after every
   * deploy. Accepts a directory path, a `Drizzle.Schema`, or
   * `{ dir, table? }`.
   */
  migrations?: MigrationsInput;
}

export interface ServiceAttributes {
  /** Postgres service ID. */
  postgresId: string;
  /** Organization ID. */
  organizationId: string;
  /** Service name. */
  name: string;
  /** Cloud provider. */
  provider: string | undefined;
  /** Region. */
  region: string | undefined;
  /** Postgres major version. */
  postgresVersion: string | undefined;
  /** VM size. */
  size: string | undefined;
  /** High availability type. */
  haType: string | undefined;
  /** Hot standbys. */
  standbyCount: number | undefined;
  /** `running` once deploy returns. */
  state: string | undefined;
  /** Whether the service is a primary (false for a read replica). */
  isPrimary: boolean | undefined;
  /** Host name. */
  hostname: string | undefined;
  /** Superuser name. */
  username: string | undefined;
  /** Superuser password (the `password` prop, or the one ClickHouse generated). */
  password: Redacted.Redacted<string> | undefined;
  /** SHA-256 of the last `password` prop applied. */
  passwordDigest: Redacted.Redacted<string> | undefined;
  /**
   * `postgresql://` URL with the superuser's credentials. The server's
   * certificate is signed by `caCertificates`, not a public CA: pass them
   * to your driver (e.g. `ssl: { ca }` with `pg`) to verify it.
   */
  connectionString: Redacted.Redacted<string> | undefined;
  /** PEM CA certificates to verify the server with. */
  caCertificates: string | undefined;
  /** Storage size in GB. */
  storageSize: number | undefined;
  /** Earliest point a restore can target, once the first backup completed. */
  earliestRestoreTime: string | undefined;
  /** Whether deletion protection is on. */
  deletionProtection: boolean;
  /** IPv4 access rules, with their IDs. */
  ipAccessList: Array<PostgresIpAccessEntry & { id: string | undefined }>;
  /** Tags, including alchemy's. */
  tags: Record<string, string>;
  /** When the service was created. */
  createdAt: string | undefined;
  /** Directory of the applied migrations. */
  migrationsDir: string | undefined;
  /** Migration bookkeeping table. */
  migrationsTable: string | undefined;
  /** Applied migration hashes. */
  migrationsHashes: Record<string, string>;
}

export type Service = Resource<
  "ClickHouseCloud.Postgres.Service",
  ServiceProps,
  ServiceAttributes,
  never,
  Providers
>;

/**
 * A managed Postgres service in ClickHouse Cloud, with PgBouncer: a new
 * primary, a read replica of another service (`replicaOf`), or a
 * point-in-time restore of one (`restoreFrom`). The endpoints are in beta.
 *
 * Deploy returns once the service is `running`. ClickHouse generates a
 * superuser password and returns it once; alchemy keeps it, and the
 * connection string, as `Redacted` attributes. `migrations` run as that
 * superuser over verified TLS after every deploy. Renaming changes the host
 * name and certificates. A replica whose `replicaOf` is removed is
 * promoted in place. Deletion protection is a per-organization feature:
 * where ClickHouse hasn't enabled it, `deletionProtection: true` fails
 * with `DeletionProtectionNotEnabled`.
 * @see https://clickhouse.com/docs/cloud/managed-postgres
 *
 * ### Creating a Database
 * **Example:** The smallest service, with migrations
 * ```typescript
 * const db = yield* ClickHouseCloud.Postgres.Service("AppDb", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   size: "r6gd.medium",
 *   migrations: "./migrations",
 * });
 * // db.connectionString -> Redacted postgresql:// URL
 * ```
 *
 * ### Network Access
 * **Example:** Only PgBouncer, only from the office
 * ```typescript
 * const db = yield* ClickHouseCloud.Postgres.Service("AppDb", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   size: "r6gd.medium",
 *   ipAccessList: [{ source: "203.0.113.0/24", portRange: "6432", description: "office" }],
 * });
 * ```
 *
 * ### Replicas and Restores
 * **Example:** A read replica
 * ```typescript
 * const replica = yield* ClickHouseCloud.Postgres.Service("AppDbReplica", {
 *   replicaOf: db.postgresId,
 * });
 * ```
 *
 * **Example:** Restore yesterday's state into a new service
 * ```typescript
 * const restored = yield* ClickHouseCloud.Postgres.Service("AppDbRestored", {
 *   restoreFrom: { postgresId: db.postgresId, target: "2026-11-11T12:00:00Z" },
 * });
 * ```
 *
 * ### Tuning
 * **Example:** More work memory and transaction pooling
 * ```typescript
 * const db = yield* ClickHouseCloud.Postgres.Service("AppDb", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   size: "r6gd.large",
 *   haType: "async",
 *   pgConfig: { work_mem: "64MB" },
 *   pgBouncerConfig: { pool_mode: "transaction" },
 * });
 * ```
 *
 * :::caution
 * Changing `provider`, `region`, `postgresVersion` or `restoreFrom`, or
 * setting `replicaOf`, replaces the service: the old one is deleted with
 * its data.
 * :::
 *
 * Uses ClickHouse Cloud API endpoints marked Beta: `createPostgresService`, `createPostgresServiceReadReplica`, `deletePostgresService`, `getPostgresService`, `getPostgresServiceCaCertificates`, `getPostgresServiceConfig`, `listPostgresServices`, `replacePostgresServiceConfig`, `restorePostgresService`, `updatePostgresService`, `updatePostgresServiceConfig`, `updatePostgresServicePassword`, `updatePostgresServiceState`.
 *
 * @resource
 * @product Postgres
 */
export const Service = Resource<Service>("ClickHouseCloud.Postgres.Service");

const CREATE_ONLY = ["provider", "region", "postgresVersion", "restoreFrom"] as const;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * A connect failure that goes away on its own: ClickHouse applies a new
 * superuser password a few seconds after the API accepts it (live: about
 * 5 s, the old one is refused at once), and after a rename the new host
 * name first doesn't resolve, then presents the old certificate (live:
 * over a minute each).
 */
const isSettling = (cause: unknown) => {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  return (
    code === "28P01" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID"
  );
};

const asRedacted = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? value : Redacted.make(value);

const tagRecord = (tags: postgres.ResourceTagsV1[] | undefined) =>
  Object.fromEntries((tags ?? []).map((t) => [t.key, t.value ?? ""]));

const toStrings = (map: object | undefined) =>
  Object.fromEntries(
    Object.entries(map ?? {}).flatMap(([k, v]) =>
      v === undefined || v === null ? [] : [[k, String(v)]],
    ),
  ) as Record<string, string>;

const toAttributes = (
  organizationId: string,
  svc: postgres.PostgresService,
  secrets: {
    password: Redacted.Redacted<string> | undefined;
    passwordDigest: Redacted.Redacted<string> | undefined;
    connectionString: Redacted.Redacted<string> | undefined;
    caCertificates: string | undefined;
  },
  migrations: Pick<ServiceAttributes, "migrationsDir" | "migrationsTable" | "migrationsHashes">,
): ServiceAttributes => ({
  postgresId: svc.id ?? "",
  organizationId,
  name: svc.name ?? "",
  provider: svc.provider,
  region: svc.region,
  postgresVersion: svc.postgresVersion,
  size: svc.size,
  haType: svc.haType,
  standbyCount: svc.standbyCount,
  state: svc.state,
  isPrimary: svc.isPrimary,
  hostname: svc.hostname,
  username: svc.username,
  password: secrets.password,
  passwordDigest: secrets.passwordDigest,
  connectionString: secrets.connectionString,
  caCertificates: secrets.caCertificates,
  storageSize: svc.storageSize,
  earliestRestoreTime: svc.earliestRestoreTime,
  deletionProtection: svc.deletionProtection ?? false,
  ipAccessList: (svc.ipAccessList ?? []).map((e) => ({
    id: e.id,
    source: e.source,
    portRange: e.portRange,
    ...(e.description !== undefined ? { description: e.description } : {}),
  })),
  tags: tagRecord(svc.tags),
  createdAt: svc.createdAt,
  ...migrations,
});

const getLive = (organizationId: string, postgresId: string) =>
  postgres.getPostgresService({ organizationId, postgresId }).pipe(
    Effect.map((svc) => (svc.state === "deleting" ? undefined : svc)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const READY: Partial<Record<string, true>> = { running: true };
const STUCK: Partial<Record<string, true>> = { unavailable: true, stopped: true };

const waitRunning = (
  organizationId: string,
  postgresId: string,
  session: ScopedPlanStatusSession,
) =>
  pollUntil({
    kind: "Postgres service",
    id: postgresId,
    waitingFor: "running",
    read: getLive(organizationId, postgresId),
    state: (svc) => svc?.state,
    done: (svc): svc is postgres.PostgresService =>
      svc !== undefined && READY[svc.state ?? ""] === true,
    failed: (svc) =>
      svc === undefined
        ? "deleted while waiting"
        : STUCK[svc.state ?? ""]
          ? `state ${svc.state} is not reached through the API`
          : undefined,
    session,
    budget: Duration.minutes(45),
  });

/** The connection URL, from what create returned or from the parts. */
/**
 * The connection URL for `password`: the one ClickHouse returned at create
 * with the password swapped in, so its form stays ClickHouse's, or else
 * built from the host name and user.
 */
const connectionUrl = (
  svc: postgres.PostgresService,
  password: Redacted.Redacted<string>,
  template: Redacted.Redacted<string> | undefined,
) => {
  if (template !== undefined) {
    const url = new URL(Redacted.value(template));
    url.password = encodeURIComponent(password.pipe(Redacted.value));
    // A rename moves the service to a new host name.
    if (svc.hostname !== undefined) url.hostname = svc.hostname;
    return Redacted.make(url.toString());
  }
  return Redacted.make(
    `postgresql://${encodeURIComponent(svc.username ?? "postgres")}:${encodeURIComponent(
      password.pipe(Redacted.value),
    )}@${svc.hostname}:5432/postgres`,
  );
};

const sameRule = (a: PostgresIpAccessEntry, b: PostgresIpAccessEntry) =>
  a.source.replace(/\/32$/, "") === b.source.replace(/\/32$/, "") &&
  a.portRange === b.portRange &&
  (a.description ?? "") === (b.description ?? "");

/** The name alchemy generates: host names are lowercase. */
const postgresName = (id: string) => Effect.map(physicalName(id), (name) => name.toLowerCase());

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const findOwned = Effect.fn(function* (
        id: string,
        instanceId: string,
        organizationId: string,
      ) {
        const all = yield* postgres.listPostgresServices({ organizationId });
        for (const candidate of all) {
          if (candidate.id === undefined || candidate.state === "deleting") continue;
          const sameInstance = (candidate.tags ?? []).some(
            (t) => t.key === INSTANCE_TAG && t.value === instanceId,
          );
          if (sameInstance && (yield* hasOwnerTags(id, candidate.tags))) {
            return yield* getLive(organizationId, candidate.id);
          }
        }
        return undefined;
      });
      const caCertificates = (organizationId: string, postgresId: string) =>
        postgres.getPostgresServiceCaCertificates({ organizationId, postgresId });

      return {
        stables: ["postgresId", "organizationId", "provider", "region", "createdAt"],
        list: Effect.fn(function* () {
          const organizationId = yield* currentOrganizationId;
          const all = yield* postgres.listPostgresServices({ organizationId });
          const empty = {
            password: undefined,
            passwordDigest: undefined,
            connectionString: undefined,
            caCertificates: undefined,
          };
          const none = {
            migrationsDir: undefined,
            migrationsTable: undefined,
            migrationsHashes: {},
          };
          // Replicas first: a source is never deleted under a live replica.
          return all
            .filter((s) => s.id !== undefined && s.state !== "deleting" && isAlchemyTagged(s.tags))
            .sort((a, b) => Number(a.isPrimary ?? true) - Number(b.isPrimary ?? true))
            .map((s) => toAttributes(organizationId, s, empty, none));
        }),
        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news) || output === undefined || olds === undefined) return undefined;
          if (CREATE_ONLY.some((key) => !deepEqual(news[key], olds[key]))) {
            return { action: "replace" } as const;
          }
          // A primary can't become a replica; another source is another service.
          if (news.replicaOf !== undefined && news.replicaOf !== olds.replicaOf) {
            return { action: "replace" } as const;
          }
          if (yield* diffMigrations({ news, output })) return { action: "update" } as const;
          return undefined;
        }),
        read: Effect.fn(function* ({ id, instanceId, olds, output }) {
          const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
          const secrets = {
            password: output?.password,
            passwordDigest: output?.passwordDigest,
            connectionString: output?.connectionString,
            caCertificates: output?.caCertificates,
          };
          const migrations = {
            migrationsDir: output?.migrationsDir,
            migrationsTable: output?.migrationsTable,
            migrationsHashes: output?.migrationsHashes ?? {},
          };
          if (output?.postgresId) {
            const live = yield* getLive(organizationId, output.postgresId);
            return live ? toAttributes(organizationId, live, secrets, migrations) : undefined;
          }
          const owned = yield* findOwned(id, instanceId, organizationId);
          if (owned) return toAttributes(organizationId, owned, secrets, migrations);
          if (olds?.name === undefined) return undefined;
          const all = yield* postgres.listPostgresServices({ organizationId });
          const named = all.find((s) => s.name === olds.name && s.state !== "deleting");
          if (named?.id === undefined || (yield* hasOwnerTags(id, named.tags))) return undefined;
          const live = yield* getLive(organizationId, named.id);
          return live
            ? Unowned(toAttributes(organizationId, live, secrets, migrations))
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output, session }) {
          const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
          const name = news.name ?? output?.name ?? (yield* postgresName(id));
          const owner = yield* ownerTags(id);
          const desiredTags: Record<string, string> = {
            ...Object.fromEntries(
              Object.entries(news.tags ?? {}).filter(([k]) => !k.startsWith("alchemy.")),
            ),
            ...owner,
            [INSTANCE_TAG]: instanceId,
          };
          const tagList = Object.entries(desiredTags).map(([key, value]) => ({ key, value }));
          let password = output?.password;
          let passwordDigest = output?.passwordDigest;
          let connectionString = output?.connectionString;

          // Observe
          const found =
            (output?.postgresId ? yield* getLive(organizationId, output.postgresId) : undefined) ??
            (yield* findOwned(id, instanceId, organizationId));

          // Ensure, by source, then wait until it runs.
          let current: postgres.PostgresService;
          let postgresId: string;
          if (found?.id === undefined) {
            yield* session.note(`Creating Postgres service "${name}"...`);
            const config = {
              pgConfig: news.pgConfig as postgres.PgConfig | undefined,
              pgBouncerConfig: news.pgBouncerConfig,
            };
            const created =
              news.replicaOf !== undefined
                ? yield* postgres.createPostgresServiceReadReplica({
                    organizationId,
                    postgresId: news.replicaOf,
                    name,
                    tags: tagList,
                    ...config,
                  })
                : news.restoreFrom !== undefined
                  ? yield* postgres.restorePostgresService({
                      organizationId,
                      postgresId: news.restoreFrom.postgresId,
                      restoreTarget: news.restoreFrom.target,
                      name,
                      tags: tagList,
                      ...config,
                    })
                  : news.provider === undefined ||
                      news.region === undefined ||
                      news.size === undefined
                    ? yield* new FeatureUnavailable({
                        feature: "Postgres service",
                        reason: "a new primary needs `provider`, `region` and `size`",
                      })
                    : yield* postgres.createPostgresService({
                        organizationId,
                        name,
                        provider: news.provider,
                        region: news.region,
                        size: news.size,
                        postgresVersion: news.postgresVersion,
                        haType: news.haType,
                        standbyCount: news.standbyCount,
                        ipAccessList: news.ipAccessList,
                        tags: tagList,
                        ...config,
                      });
            if (created.id === undefined) {
              return yield* new MissingId({ operation: "createPostgresService" });
            }
            // Returned only now.
            password = asRedacted(created.password);
            connectionString = asRedacted(created.connectionString);
            passwordDigest = undefined;
            postgresId = created.id;
            current = yield* waitRunning(organizationId, postgresId, session);
          } else {
            postgresId = found.id;
            current =
              found.state === "running"
                ? found
                : yield* waitRunning(organizationId, postgresId, session);
          }

          // Promote a replica whose source was removed from the props.
          if (
            olds?.replicaOf !== undefined &&
            news.replicaOf === undefined &&
            current.isPrimary === false
          ) {
            yield* session.note("Promoting the replica...");
            yield* postgres.updatePostgresServiceState({
              organizationId,
              postgresId,
              command: "promote",
            });
            current = yield* waitRunning(organizationId, postgresId, session);
          }

          // Sync basic settings in one PATCH.
          const observedTags = tagRecord(current.tags);
          const observedRules = current.ipAccessList ?? [];
          const desiredRules = news.ipAccessList;
          const removeRules =
            desiredRules === undefined
              ? []
              : observedRules.filter((o) => !desiredRules.some((d) => sameRule(o, d)));
          const addRules =
            desiredRules === undefined
              ? []
              : desiredRules.filter((d) => !observedRules.some((o) => sameRule(o, d)));
          const patch: Omit<
            postgres.UpdatePostgresServiceRequest,
            "organizationId" | "postgresId"
          > = {
            ...(current.name !== name ? { name } : {}),
            ...(news.size !== undefined &&
            news.replicaOf === undefined &&
            news.size !== current.size
              ? { size: news.size }
              : {}),
            ...(news.haType !== undefined && news.haType !== current.haType
              ? { haType: news.haType }
              : {}),
            ...(news.standbyCount !== undefined && news.standbyCount !== current.standbyCount
              ? { standbyCount: news.standbyCount }
              : {}),
            ...(!deepEqual(observedTags, desiredTags) ? { tags: tagList } : {}),
            ...((news.deletionProtection ?? false) !== (current.deletionProtection ?? false)
              ? { deletionProtection: news.deletionProtection ?? false }
              : {}),
            ...(removeRules.length > 0 || addRules.length > 0
              ? {
                  ipAccessList: {
                    ...(removeRules.length > 0
                      ? {
                          remove: removeRules.flatMap((r) =>
                            r.id === undefined ? [] : [{ id: r.id }],
                          ),
                        }
                      : {}),
                    ...(addRules.length > 0 ? { add: addRules } : {}),
                  },
                }
              : {}),
          };
          if (Object.keys(patch).length > 0) {
            yield* postgres.updatePostgresService({ organizationId, postgresId, ...patch });
            current = yield* waitRunning(organizationId, postgresId, session);
          }

          // Sync configuration: PATCH changed keys, or POST the whole map
          // when a key was dropped so it goes back to its default.
          if (
            news.pgConfig !== undefined ||
            news.pgBouncerConfig !== undefined ||
            olds?.pgConfig !== undefined ||
            olds?.pgBouncerConfig !== undefined
          ) {
            const observedConfig = yield* postgres.getPostgresServiceConfig({
              organizationId,
              postgresId,
            });
            const wantPg = toStrings(news.pgConfig);
            const wantBouncer = toStrings(news.pgBouncerConfig);
            const havePg = toStrings(observedConfig.pgConfig);
            const haveBouncer = toStrings(observedConfig.pgBouncerConfig);
            const dropped =
              Object.keys(olds?.pgConfig ?? {}).some((k) => !(k in wantPg)) ||
              Object.keys(olds?.pgBouncerConfig ?? {}).some((k) => !(k in wantBouncer));
            const changed =
              Object.entries(wantPg).some(([k, v]) => havePg[k] !== v) ||
              Object.entries(wantBouncer).some(([k, v]) => haveBouncer[k] !== v);
            if (dropped || changed) {
              const body = {
                organizationId,
                postgresId,
                pgConfig: (news.pgConfig ?? {}) as postgres.PgConfig,
                pgBouncerConfig: news.pgBouncerConfig ?? {},
              };
              const result = yield* dropped
                ? postgres.replacePostgresServiceConfig(body)
                : postgres.updatePostgresServiceConfig(body);
              if (result.message) yield* session.note(result.message);
              current = yield* waitRunning(organizationId, postgresId, session);
            }
          }

          // Password: write-only, compared through the digest of the last value applied.
          if (news.password !== undefined) {
            const digest = sha256(news.password.pipe(Redacted.value));
            if (passwordDigest === undefined || Redacted.value(passwordDigest) !== digest) {
              yield* postgres.updatePostgresServicePassword({
                organizationId,
                postgresId,
                password: news.password,
              });
            }
            password = news.password;
            passwordDigest = Redacted.make(digest);
            connectionString = connectionUrl(current, news.password, connectionString);
          } else if (password === undefined) {
            // No password held (credential redaction, or a lost create): reset it.
            const reset = yield* postgres.updatePostgresServicePassword({
              organizationId,
              postgresId,
            });
            password = asRedacted(reset.password);
          }
          if (connectionString === undefined && password !== undefined) {
            connectionString = connectionUrl(current, password, undefined);
          }

          const ca = yield* caCertificates(organizationId, postgresId);

          // Migrations last, as the superuser over verified TLS.
          const migrationsInput = migrationsInputOf(news);
          const superuserPassword = password;
          const run =
            migrationsInput && superuserPassword !== undefined
              ? yield* runMigrations({
                  input: migrationsInput,
                  stamped: stampedOf(output),
                  withExecutor: (apply) =>
                    withPgExecutor(
                      {
                        host: current.hostname,
                        port: 5432,
                        user: current.username ?? "postgres",
                        password: Redacted.value(superuserPassword),
                        database: "postgres",
                        ssl: { ca, rejectUnauthorized: true },
                      },
                      apply,
                      {
                        // A password set moments ago (or a just-created host
                        // name) takes a few seconds to apply.
                        retryConnect: {
                          while: isSettling,
                          times: 120,
                          interval: "5 seconds",
                        },
                      },
                    ),
                })
              : undefined;

          const final = (yield* getLive(organizationId, postgresId)) ?? current;
          return toAttributes(
            organizationId,
            final,
            { password, passwordDigest, connectionString, caCertificates: ca },
            migrationsAttrs({ input: migrationsInput, run, output }),
          );
        }),
        delete: Effect.fn(function* ({ output, session }) {
          const { organizationId, postgresId } = output;
          if ((yield* getLive(organizationId, postgresId)) === undefined) return;
          yield* session.note("Deleting the Postgres service...");
          yield* postgres
            .deletePostgresService({ organizationId, postgresId })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
          yield* pollUntil({
            kind: "Postgres service",
            id: postgresId,
            waitingFor: "deleted",
            // Live: right after the delete, a read once answered 403 before
            // the service showed as deleting; that answer passes.
            read: getLive(organizationId, postgresId).pipe(
              Effect.retry({
                while: (error) => error._tag === "Forbidden",
                schedule: Schedule.spaced("3 seconds"),
                times: 5,
              }),
            ),
            state: (svc) => svc?.state,
            done: (svc): svc is undefined => svc === undefined,
            session,
            budget: Duration.minutes(30),
          });
        }),
      };
    }),
  );
