import * as dsql from "@distilled.cloud/aws/dsql";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  diffMigrations,
  migrationsAttrs,
  migrationsInputOf,
  stampedOf,
  type MigrationsInput,
} from "../../SQL/Migrations/index.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { runDsqlMigrations } from "./Migrations.ts";

export interface ClusterProps {
  /**
   * Enables deletion protection. While enabled the cluster cannot be deleted;
   * the provider automatically disables it during delete so `stack.destroy()`
   * always succeeds.
   * @default false
   */
  deletionProtectionEnabled?: boolean;
  /**
   * ARN of a customer-managed KMS key used to encrypt the cluster at rest.
   * Changing the key replaces the cluster.
   * @default an AWS-owned key
   */
  kmsEncryptionKey?: string;
  /**
   * SQL migrations to apply to the cluster's `postgres` database on deploy,
   * connecting as `admin` with an IAM auth token. Accepts a directory path,
   * a `Drizzle.Schema` resource, or `{ dir, table? }`.
   *
   * Bookkeeping always lives in Alchemy's `__alchemy_migrations` table. A
   * database previously migrated by drizzle-kit or Prisma is adopted by a
   * one-way conversion on first deploy: the old tool's applied history is
   * copied into Alchemy's table and the old table is left frozen.
   *
   * DSQL runs at most one DDL statement per transaction, so each statement
   * commits on its own: put every DDL statement in its own file or separate
   * statements with `--> statement-breakpoint` (drizzle-kit's default).
   */
  migrations?: MigrationsInput;
  /**
   * User-defined tags for the cluster.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "AWS.DSQL.Cluster",
  ClusterProps,
  {
    /** The unique cluster identifier assigned by DSQL. */
    clusterId: string;
    /** The ARN of the cluster. */
    clusterArn: string;
    /** The current status of the cluster, e.g. `ACTIVE`. */
    status: string;
    /**
     * The public cluster endpoint hostname, e.g.
     * `<clusterId>.dsql.<region>.on.aws`. Connect with a Postgres wire client
     * using an IAM-generated auth token as the password.
     */
    endpoint: string;
    /** Whether deletion protection is enabled on the cluster. */
    deletionProtectionEnabled: boolean;
    /** Directory of the applied SQL migrations. */
    migrationsDir: string | undefined;
    /** Migration bookkeeping table. */
    migrationsTable: string | undefined;
    /** Applied migration content hashes. */
    migrationsHashes: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Aurora DSQL cluster — a serverless, distributed SQL database with
 * active-active high availability and Postgres wire compatibility.
 *
 * Clusters are pay-per-use with no provisioned capacity, so they have
 * excellent test economics. Create is asynchronous (`CREATING` -> `ACTIVE`),
 * usually completing in under a minute; the provider waits for `ACTIVE`
 * (bounded) before returning.
 * ### Creating a Cluster
 * **Example:** Basic Cluster
 * ```typescript
 * const cluster = yield* Cluster("AppDb", {});
 * // connect to cluster.endpoint on port 5432 as user "admin"
 * ```
 *
 * **Example:** Cluster with Deletion Protection
 * ```typescript
 * const cluster = yield* Cluster("AppDb", {
 *   deletionProtectionEnabled: true,
 * });
 * ```
 *
 * **Example:** Cluster with a Customer-Managed KMS Key
 * ```typescript
 * const cluster = yield* Cluster("AppDb", {
 *   kmsEncryptionKey: key.keyArn,
 * });
 * ```
 *
 * ### Migrations
 * Point `migrations` at a folder of migration files. Pending migrations are
 * applied in order on each deploy; already-applied ones are skipped.
 *
 * **Example:** Apply migrations from a directory
 * ```typescript
 * const cluster = yield* Cluster("AppDb", {
 *   migrations: "./migrations",
 * });
 * ```
 *
 * **Example:** Drizzle migrations
 * ```typescript
 * const schema = yield* Drizzle.Schema("app-schema", {
 *   schema: "./src/schema.ts",
 *   dialect: "postgres",
 * });
 * const cluster = yield* Cluster("AppDb", { migrations: schema });
 * ```
 *
 * @resource
 */
export const Cluster = Resource<Cluster>("AWS.DSQL.Cluster");

const activeStatuses = new Set(["ACTIVE", "IDLE"]);

export const ClusterProvider = () =>
  Provider.effect(
    Cluster,
    Effect.gen(function* () {
      const endpointFor = (identifier: string, region: string) =>
        `${identifier}.dsql.${region}.on.aws`;

      const readCluster = Effect.fn(function* (identifier: string) {
        return yield* dsql
          .getCluster({ identifier })
          .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)));
      });

      const readTags = Effect.fn(function* (arn: string) {
        const response = yield* dsql
          .listTagsForResource({ resourceArn: arn })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        return Object.fromEntries(
          Object.entries(response?.tags ?? {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      });

      // Bounded readiness wait. DSQL clusters usually reach ACTIVE within a
      // minute; budget ~5 min (60 * 5s) so slow provisioning still converges
      // without risking the test wall.
      const waitForActive = Effect.fn(function* (identifier: string) {
        const policy = Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(60)]);
        return yield* readCluster(identifier).pipe(
          Effect.flatMap((cluster) => {
            if (cluster === undefined) {
              return Effect.fail(new Error(`DSQL cluster '${identifier}' not found`));
            }
            if (!activeStatuses.has(cluster.status)) {
              return Effect.fail(
                new Error(`DSQL cluster '${identifier}' not active (status: ${cluster.status})`),
              );
            }
            return Effect.succeed(cluster);
          }),
          Effect.retry({ schedule: policy }),
        );
      });

      const toAttrs = (
        cluster: dsql.GetClusterOutput | dsql.CreateClusterOutput,
        region: string,
      ) => ({
        clusterId: cluster.identifier,
        clusterArn: cluster.arn,
        status: cluster.status,
        endpoint: cluster.endpoint ?? endpointFor(cluster.identifier, region),
        deletionProtectionEnabled: cluster.deletionProtectionEnabled,
      });

      // Migration state lives in the database, not the cluster API, so it
      // is carried over from prior state rather than observed.
      const migrationsStateOf = (output: Cluster["Attributes"] | undefined) => ({
        migrationsDir: output?.migrationsDir,
        migrationsTable: output?.migrationsTable,
        migrationsHashes: output?.migrationsHashes ?? {},
      });

      return {
        stables: ["clusterId", "clusterArn", "endpoint"],

        diff: Effect.fn(function* ({ olds = {}, news, output }) {
          if (!isResolved(news)) return undefined;
          // KMS key is create-only; changing it forces a replacement.
          if ((news.kmsEncryptionKey ?? undefined) !== (olds.kmsEncryptionKey ?? undefined)) {
            return { action: "replace" } as const;
          }
          if (yield* diffMigrations({ news, output })) {
            return { action: "update" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, output }) {
          if (output?.clusterId === undefined) return undefined;
          const { region } = yield* AWSEnvironment.current;
          const cluster = yield* readCluster(output.clusterId);
          if (cluster === undefined || cluster.status === "DELETED") {
            return undefined;
          }
          const tags = yield* readTags(cluster.arn);
          const attrs = { ...toAttrs(cluster, region), ...migrationsStateOf(output) };
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const { region } = yield* AWSEnvironment.current;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative; output caches the id.
          let observed =
            output?.clusterId === undefined ? undefined : yield* readCluster(output.clusterId);

          // 2. Ensure — create if missing. DSQL assigns the identifier.
          let identifier = observed?.identifier ?? output?.clusterId;
          if (observed === undefined) {
            const created = yield* dsql.createCluster({
              deletionProtectionEnabled: news.deletionProtectionEnabled ?? false,
              kmsEncryptionKey: news.kmsEncryptionKey,
              tags: desiredTags,
            });
            identifier = created.identifier;
          }

          // Wait for ACTIVE so subsequent syncs do not hit ConflictException.
          const active = yield* waitForActive(identifier!);
          observed = active;

          // 3. Sync deletion protection against observed state.
          if (
            news.deletionProtectionEnabled !== undefined &&
            news.deletionProtectionEnabled !== observed.deletionProtectionEnabled
          ) {
            yield* dsql.updateCluster({
              identifier: identifier!,
              deletionProtectionEnabled: news.deletionProtectionEnabled,
            });
            observed = yield* waitForActive(identifier!);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const observedTags = yield* readTags(observed.arn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* dsql.tagResource({
              resourceArn: observed.arn,
              tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }
          if (removed.length > 0) {
            yield* dsql.untagResource({
              resourceArn: observed.arn,
              tagKeys: removed,
            });
          }

          // 3c. Sync migrations — the shared pipeline skips applied files,
          // so this converges on create, update, and adoption alike.
          // A cluster recreated out-of-band has an empty database, so prior
          // migration state only carries over for the same cluster.
          const previous = output?.clusterId === observed.identifier ? output : undefined;
          const attrs = toAttrs(observed, region);
          const migrationsInput = migrationsInputOf(news);
          const migrations = migrationsInput
            ? yield* runDsqlMigrations({
                endpoint: attrs.endpoint,
                input: migrationsInput,
                stamped: stampedOf(previous),
              })
            : undefined;

          yield* session.note(identifier!);
          return {
            ...attrs,
            ...migrationsAttrs({ input: migrationsInput, run: migrations, output: previous }),
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          const identifier = output.clusterId;
          const existing = yield* readCluster(identifier);
          if (existing === undefined) return;
          // Deletion protection blocks delete — disable it first.
          if (existing.deletionProtectionEnabled) {
            yield* dsql
              .updateCluster({
                identifier,
                deletionProtectionEnabled: false,
              })
              .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
          }
          yield* dsql.deleteCluster({ identifier }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            // A cluster still CREATING rejects delete with ConflictException;
            // retry briefly until it settles into a deletable state.
            Effect.retry({
              while: (e) => e._tag === "ConflictException",
              schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(24)]),
            }),
          );
        }),

        list: () =>
          Effect.gen(function* () {
            const { region } = yield* AWSEnvironment.current;
            const summaries = yield* dsql.listClusters.items({}).pipe(
              Stream.runCollect,
              Effect.map((c) => Array.from(c)),
            );
            return yield* Effect.forEach(
              summaries,
              (summary) =>
                readCluster(summary.identifier).pipe(
                  Effect.map((cluster) =>
                    cluster === undefined || cluster.status === "DELETED"
                      ? undefined
                      : { ...toAttrs(cluster, region), ...migrationsStateOf(undefined) },
                  ),
                ),
              { concurrency: 4 },
            ).pipe(
              Effect.map((attrs) =>
                attrs.filter((a): a is NonNullable<typeof a> => a !== undefined),
              ),
            );
          }),
      };
    }),
  );
