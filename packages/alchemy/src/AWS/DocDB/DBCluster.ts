import * as docdb from "@distilled.cloud/aws/docdb";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";

export interface DBClusterProps {
  /**
   * Cluster identifier. If omitted, Alchemy generates one.
   */
  dbClusterIdentifier?: string;
  /**
   * Database engine. DocumentDB only supports `docdb`.
   * Changing it forces replacement.
   * @default "docdb"
   */
  engine?: string;
  /**
   * Optional engine version, e.g. `5.0.0`. Changed in place via
   * `modifyDBCluster` (may require `allowMajorVersionUpgrade`).
   */
  engineVersion?: string;
  /**
   * Subnet group the cluster is placed into. DocumentDB is VPC-only, so this
   * is effectively required. Immutable — forces replacement.
   */
  dbSubnetGroupName?: string;
  /**
   * Cluster parameter group name. In-place modify.
   */
  dbClusterParameterGroupName?: string;
  /**
   * Security groups attached to the cluster. In-place modify.
   */
  vpcSecurityGroupIds?: string[];
  /**
   * Listener port.
   * @default 27017
   */
  port?: number;
  /**
   * Availability zones for cluster placement. Immutable — forces replacement.
   */
  availabilityZones?: string[];
  /**
   * Backup retention period in days. In-place modify.
   */
  backupRetentionPeriod?: number;
  /**
   * Daily backup window, e.g. `07:00-09:00`. In-place modify.
   */
  preferredBackupWindow?: string;
  /**
   * Weekly maintenance window, e.g. `Mon:00:00-Mon:03:00`. In-place modify.
   */
  preferredMaintenanceWindow?: string;
  /**
   * Log types to export to CloudWatch Logs (`audit`, `profiler`). Diffed
   * against observed state and applied via the delta-shaped
   * `CloudwatchLogsExportConfiguration` on modify.
   */
  enableCloudwatchLogsExports?: string[];
  /**
   * Block accidental deletion. In-place modify.
   */
  deletionProtection?: boolean;
  /**
   * Whether the storage is encrypted. Immutable — forces replacement.
   */
  storageEncrypted?: boolean;
  /**
   * Optional KMS key used for storage encryption. Immutable — forces replace.
   */
  kmsKeyId?: string;
  /**
   * Storage type, e.g. `standard` | `iopt1`. In-place modify.
   */
  storageType?: string;
  /**
   * Network type: `IPV4` | `DUAL`. In-place modify.
   */
  networkType?: string;
  /**
   * Join this cluster to a DocumentDB global cluster. Immutable on create.
   */
  globalClusterIdentifier?: string;
  /**
   * Master username. Immutable — forces replacement.
   */
  masterUsername?: string;
  /**
   * Master password. In-place modify.
   */
  masterUserPassword?: Redacted.Redacted<string>;
  /**
   * Let DocumentDB manage the master user password in Secrets Manager.
   */
  manageMasterUserPassword?: boolean;
  /**
   * Rotate the managed master user password on the next reconcile.
   */
  rotateMasterUserPassword?: boolean;
  /**
   * KMS key used to encrypt the managed master user secret. In-place modify.
   */
  masterUserSecretKmsKeyId?: string;
  /**
   * Allow a major engine-version upgrade during a modify. Modify-only flag.
   */
  allowMajorVersionUpgrade?: boolean;
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DBCluster extends Resource<
  "AWS.DocDB.DBCluster",
  DBClusterProps,
  {
    dbClusterIdentifier: string;
    dbClusterArn: string;
    dbSubnetGroupName: string | undefined;
    endpoint: string | undefined;
    readerEndpoint: string | undefined;
    port: number | undefined;
    engine: string;
    engineVersion: string | undefined;
    status: string | undefined;
    masterUsername: string | undefined;
    masterUserSecretArn: string | undefined;
    vpcSecurityGroupIds: string[];
    backupRetentionPeriod: number | undefined;
    preferredBackupWindow: string | undefined;
    preferredMaintenanceWindow: string | undefined;
    storageEncrypted: boolean | undefined;
    kmsKeyId: string | undefined;
    deletionProtection: boolean | undefined;
    dbClusterMembers: Array<{
      dbInstanceIdentifier: string | undefined;
      isClusterWriter: boolean | undefined;
      promotionTier: number | undefined;
    }>;
    dbClusterResourceId: string | undefined;
    hostedZoneId: string | undefined;
    multiAZ: boolean | undefined;
    enabledCloudwatchLogsExports: string[];
    clusterCreateTime: string | undefined;
    storageType: string | undefined;
    networkType: string | undefined;
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon DocumentDB (MongoDB-compatible) cluster.
 *
 * `DBCluster` owns the writer and reader endpoints and cluster-wide
 * networking; instances are added via {@link DBInstance}. It can bootstrap
 * master credentials directly or let DocumentDB manage them in Secrets Manager.
 * Provisioning a cluster (and its first instance) takes several minutes.
 *
 * Mutable fields are reconciled in place against the observed cloud state;
 * immutable fields (`engine`, `dbSubnetGroupName`, `storageEncrypted`,
 * `kmsKeyId`, `globalClusterIdentifier`, `availabilityZones`,
 * `masterUsername`) force a replacement.
 * @resource
 * @section Creating a Cluster
 * @example DocumentDB cluster with a managed master secret
 * ```typescript
 * const cluster = yield* DBCluster("Docs", {
 *   dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
 *   vpcSecurityGroupIds: [sg.groupId],
 *   masterUsername: "alchemy",
 *   manageMasterUserPassword: true,
 *   backupRetentionPeriod: 7,
 *   deletionProtection: false,
 * });
 * ```
 *
 * @section Logs & Encryption
 * @example Export audit logs and encrypt storage
 * ```typescript
 * const cluster = yield* DBCluster("Docs", {
 *   dbSubnetGroupName: subnetGroup.dbSubnetGroupName,
 *   masterUsername: "alchemy",
 *   masterUserPassword: Redacted.make("supersecret"),
 *   storageEncrypted: true,
 *   enableCloudwatchLogsExports: ["audit", "profiler"],
 * });
 * ```
 */
export const DBCluster = Resource<DBCluster>("AWS.DocDB.DBCluster");

const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

const toAttrs = ({
  cluster,
  tags,
}: {
  cluster: docdb.DBCluster;
  tags: Record<string, string>;
}): DBCluster["Attributes"] => ({
  dbClusterIdentifier: cluster.DBClusterIdentifier ?? "",
  dbClusterArn: cluster.DBClusterArn ?? "",
  dbSubnetGroupName: cluster.DBSubnetGroup,
  endpoint: cluster.Endpoint,
  readerEndpoint: cluster.ReaderEndpoint,
  port: cluster.Port,
  engine: cluster.Engine ?? "docdb",
  engineVersion: cluster.EngineVersion,
  status: cluster.Status,
  masterUsername: cluster.MasterUsername,
  masterUserSecretArn: cluster.MasterUserSecret?.SecretArn,
  vpcSecurityGroupIds: (cluster.VpcSecurityGroups ?? []).flatMap((group) =>
    group.VpcSecurityGroupId ? [group.VpcSecurityGroupId] : [],
  ),
  backupRetentionPeriod: cluster.BackupRetentionPeriod,
  preferredBackupWindow: cluster.PreferredBackupWindow,
  preferredMaintenanceWindow: cluster.PreferredMaintenanceWindow,
  storageEncrypted: cluster.StorageEncrypted,
  kmsKeyId: cluster.KmsKeyId,
  deletionProtection: cluster.DeletionProtection,
  dbClusterMembers: (cluster.DBClusterMembers ?? []).map((member) => ({
    dbInstanceIdentifier: member.DBInstanceIdentifier,
    isClusterWriter: member.IsClusterWriter,
    promotionTier: member.PromotionTier,
  })),
  dbClusterResourceId: cluster.DbClusterResourceId,
  hostedZoneId: cluster.HostedZoneId,
  multiAZ: cluster.MultiAZ,
  enabledCloudwatchLogsExports: cluster.EnabledCloudwatchLogsExports ?? [],
  clusterCreateTime: cluster.ClusterCreateTime?.toISOString(),
  storageType: cluster.StorageType,
  networkType: cluster.NetworkType,
  tags,
});

/**
 * Compute the CloudWatch Logs export delta. The modify API is delta-shaped
 * (`EnableLogTypes`/`DisableLogTypes`), so it must NOT carry the full set.
 * Returns `undefined` when there is no change.
 */
const logExportDelta = (
  observed: string[] | undefined,
  desired: string[] | undefined,
): docdb.CloudwatchLogsExportConfiguration | undefined => {
  if (desired === undefined) return undefined;
  const have = new Set(observed ?? []);
  const want = new Set(desired);
  const EnableLogTypes = [...want].filter((t) => !have.has(t));
  const DisableLogTypes = [...have].filter((t) => !want.has(t));
  if (EnableLogTypes.length === 0 && DisableLogTypes.length === 0) {
    return undefined;
  }
  return {
    ...(EnableLogTypes.length > 0 ? { EnableLogTypes } : {}),
    ...(DisableLogTypes.length > 0 ? { DisableLogTypes } : {}),
  };
};

export const DBClusterProvider = () =>
  Provider.effect(
    DBCluster,
    Effect.gen(function* () {
      const toIdentifier = (id: string, props: DBClusterProps) =>
        props.dbClusterIdentifier
          ? Effect.succeed(props.dbClusterIdentifier)
          : createPhysicalName({ id, maxLength: 63 });

      const readCluster = Effect.fn(function* (clusterId: string) {
        const response = yield* docdb
          .describeDBClusters({
            DBClusterIdentifier: clusterId,
          })
          .pipe(
            Effect.catchTag("DBClusterNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DBClusters?.[0];
      });

      const readTags = Effect.fn(function* (arn: string | undefined) {
        if (!arn) return {} as Record<string, string>;
        const response = yield* docdb
          .listTagsForResource({ ResourceName: arn })
          .pipe(
            Effect.catchTag("DBClusterNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return toTagRecord(response?.TagList);
      });

      // Bounded readiness wait. Gate on cluster `Status === "available"` so a
      // follow-on `modifyDBCluster` doesn't hit `InvalidDBClusterStateFault`.
      // Budgets ~10 min (60 * 10s) for slow provisioning.
      const waitForCluster = Effect.fn(function* (clusterId: string) {
        const readinessPolicy = Schedule.fixed("10 seconds").pipe(
          Schedule.both(Schedule.recurs(60)),
        );
        return yield* readCluster(clusterId).pipe(
          Effect.flatMap((cluster) => {
            if (!cluster?.DBClusterArn) {
              return Effect.fail(
                new Error(`DB cluster '${clusterId}' not found`),
              );
            }
            if (cluster.Status !== "available") {
              return Effect.fail(
                new Error(
                  `DB cluster '${clusterId}' not available (status: ${cluster.Status})`,
                ),
              );
            }
            return Effect.succeed(cluster);
          }),
          Effect.retry({ schedule: readinessPolicy }),
        );
      });

      return {
        stables: ["dbClusterArn", "dbClusterIdentifier"],
        // AWS account/region collection: exhaustively paginate
        // `describeDBClusters` and map each cluster to the exact `read`
        // Attributes shape. DocumentDB does not surface tags inline on the
        // cluster, so — mirroring `DBSubnetGroup.list` — we emit an empty tag
        // map rather than issuing a per-item `listTagsForResource` fan-out.
        list: () =>
          docdb.describeDBClusters.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.DBClusters ?? []).map((cluster) =>
                  toAttrs({ cluster, tags: {} }),
                ),
              ),
            ),
          ),
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toIdentifier(id, olds ?? ({} as DBClusterProps))) !==
            (yield* toIdentifier(id, news))
          ) {
            return { action: "replace" } as const;
          }
          // Immutable props — any change forces a fresh cluster.
          if (
            olds !== undefined &&
            ((olds.engine ?? "docdb") !== (news.engine ?? "docdb") ||
              olds.dbSubnetGroupName !== news.dbSubnetGroupName ||
              olds.storageEncrypted !== news.storageEncrypted ||
              olds.kmsKeyId !== news.kmsKeyId ||
              olds.masterUsername !== news.masterUsername ||
              olds.globalClusterIdentifier !== news.globalClusterIdentifier ||
              JSON.stringify(olds.availabilityZones ?? []) !==
                JSON.stringify(news.availabilityZones ?? []))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const identifier =
            output?.dbClusterIdentifier ??
            (yield* toIdentifier(id, olds ?? ({} as DBClusterProps)));
          const cluster = yield* readCluster(identifier);
          if (!cluster?.DBClusterArn) {
            return undefined;
          }
          const tags = yield* readTags(cluster.DBClusterArn);
          return toAttrs({ cluster, tags });
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const identifier =
            output?.dbClusterIdentifier ?? (yield* toIdentifier(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const masterUserPassword = news.masterUserPassword
            ? Redacted.value(news.masterUserPassword)
            : undefined;

          // Observe — fetch live cluster state.
          let observed = yield* readCluster(identifier);

          // Ensure — create the cluster if it's missing. Tolerate
          // `DBClusterAlreadyExistsFault` as a race with a peer reconciler.
          if (!observed?.DBClusterArn) {
            yield* docdb
              .createDBCluster({
                DBClusterIdentifier: identifier,
                Engine: news.engine ?? "docdb",
                EngineVersion: news.engineVersion,
                DBSubnetGroupName: news.dbSubnetGroupName,
                DBClusterParameterGroupName: news.dbClusterParameterGroupName,
                VpcSecurityGroupIds: news.vpcSecurityGroupIds,
                Port: news.port,
                AvailabilityZones: news.availabilityZones,
                BackupRetentionPeriod: news.backupRetentionPeriod,
                PreferredBackupWindow: news.preferredBackupWindow,
                PreferredMaintenanceWindow: news.preferredMaintenanceWindow,
                EnableCloudwatchLogsExports: news.enableCloudwatchLogsExports,
                DeletionProtection: news.deletionProtection,
                StorageEncrypted: news.storageEncrypted,
                KmsKeyId: news.kmsKeyId,
                StorageType: news.storageType,
                NetworkType: news.networkType,
                GlobalClusterIdentifier: news.globalClusterIdentifier,
                MasterUsername: news.masterUsername,
                MasterUserPassword: masterUserPassword,
                ManageMasterUserPassword: news.manageMasterUserPassword,
                MasterUserSecretKmsKeyId: news.masterUserSecretKmsKeyId,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "DBClusterAlreadyExistsFault",
                  () => Effect.void,
                ),
              );

            observed = yield* waitForCluster(identifier);
          } else {
            // Wait for the cluster to settle before any modify so the call
            // doesn't hit `InvalidDBClusterStateFault`.
            observed = yield* waitForCluster(identifier);

            // syncCoreSettings — single `modifyDBCluster` carrying scalar
            // in-place fields, only emitting a field when the desired value
            // differs from the observed cloud state.
            const core: docdb.ModifyDBClusterMessage = {
              DBClusterIdentifier: identifier,
              ApplyImmediately: true,
            };
            let coreDirty = false;
            const setIf = <K extends keyof docdb.ModifyDBClusterMessage>(
              key: K,
              desired: docdb.ModifyDBClusterMessage[K] | undefined,
              observedValue: unknown,
            ) => {
              if (desired !== undefined && desired !== observedValue) {
                core[key] = desired;
                coreDirty = true;
              }
            };
            setIf("EngineVersion", news.engineVersion, observed.EngineVersion);
            setIf("Port", news.port, observed.Port);
            setIf("BackupRetentionPeriod", news.backupRetentionPeriod, observed.BackupRetentionPeriod); // prettier-ignore
            setIf("PreferredBackupWindow", news.preferredBackupWindow, observed.PreferredBackupWindow); // prettier-ignore
            setIf("PreferredMaintenanceWindow", news.preferredMaintenanceWindow, observed.PreferredMaintenanceWindow); // prettier-ignore
            setIf("DeletionProtection", news.deletionProtection, observed.DeletionProtection); // prettier-ignore
            setIf("StorageType", news.storageType, observed.StorageType);
            setIf("NetworkType", news.networkType, observed.NetworkType);
            setIf("DBClusterParameterGroupName", news.dbClusterParameterGroupName, observed.DBClusterParameterGroup); // prettier-ignore
            setIf("MasterUserSecretKmsKeyId", news.masterUserSecretKmsKeyId, undefined); // prettier-ignore
            if (news.vpcSecurityGroupIds !== undefined) {
              core.VpcSecurityGroupIds = news.vpcSecurityGroupIds;
              coreDirty = true;
            }
            if (news.allowMajorVersionUpgrade) {
              core.AllowMajorVersionUpgrade = true;
            }
            // syncMasterPassword — rotation or explicit password update.
            if (
              news.manageMasterUserPassword &&
              news.rotateMasterUserPassword
            ) {
              core.RotateMasterUserPassword = true;
              coreDirty = true;
            } else if (masterUserPassword !== undefined) {
              core.MasterUserPassword = masterUserPassword;
              coreDirty = true;
            }
            if (coreDirty) {
              yield* docdb.modifyDBCluster(core);
              observed = yield* waitForCluster(identifier);
            }

            // syncCloudwatchLogsExports — delta-shaped; separate call.
            const logDelta = logExportDelta(
              observed.EnabledCloudwatchLogsExports,
              news.enableCloudwatchLogsExports,
            );
            if (logDelta) {
              yield* docdb.modifyDBCluster({
                DBClusterIdentifier: identifier,
                CloudwatchLogsExportConfiguration: logDelta,
                ApplyImmediately: true,
              });
              observed = yield* waitForCluster(identifier);
            }
          }

          const dbClusterArn = observed.DBClusterArn ?? "";

          // Sync tags — diff observed cloud tags against desired.
          const observedTags = yield* readTags(dbClusterArn);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0 && dbClusterArn) {
            yield* docdb.addTagsToResource({
              ResourceName: dbClusterArn,
              Tags: upsert,
            });
          }
          if (removed.length > 0 && dbClusterArn) {
            yield* docdb.removeTagsFromResource({
              ResourceName: dbClusterArn,
              TagKeys: removed,
            });
          }

          yield* session.note(dbClusterArn || identifier);
          return toAttrs({ cluster: observed, tags: desiredTags });
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* docdb
            .deleteDBCluster({
              DBClusterIdentifier: output.dbClusterIdentifier,
              SkipFinalSnapshot: true,
            })
            .pipe(Effect.catchTag("DBClusterNotFoundFault", () => Effect.void));
          // Block until the cluster is fully gone. DocumentDB deletion is
          // async; if we return while it is still `deleting`, a dependent
          // (DBSubnetGroup or VPC) is torn down next and AWS rejects it.
          yield* Effect.repeat(
            docdb
              .describeDBClusters({
                DBClusterIdentifier: output.dbClusterIdentifier,
              })
              .pipe(
                Effect.as(true),
                Effect.catchTag("DBClusterNotFoundFault", () =>
                  Effect.succeed(false),
                ),
              ),
            {
              schedule: Schedule.fixed("15 seconds").pipe(
                Schedule.both(Schedule.recurs(40)),
              ),
              until: (exists) => exists === false,
            },
          ).pipe(Effect.catch(() => Effect.void));
        }),
      };
    }),
  );
