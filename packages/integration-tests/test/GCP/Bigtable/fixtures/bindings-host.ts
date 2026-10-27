import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { recordAuditLogs } from "../../auditLogs.ts";
import { outcome, probeParam, serveProbes } from "../../bindingHost.ts";

/** Instance GetInstance / GetCluster are granted on. */
export const Db = GCP.Bigtable.Instance("Db", {
  clusters: {
    cluster: {
      location: "us-central1-b",
      serveNodes: 1,
      defaultStorageType: "HDD",
    },
  },
});

/** The instance's cluster, managed as its own resource. */
export const Nodes = Effect.gen(function* () {
  const instance = yield* Db;
  return yield* GCP.Bigtable.Cluster("Nodes", {
    instance: instance.name,
    clusterId: "cluster",
    location: "us-central1-b",
    serveNodes: 1,
    defaultStorageType: "HDD",
  });
});

/** Table GetTable is granted on. */
export const Rows = Effect.gen(function* () {
  const instance = yield* Db;
  return yield* GCP.Bigtable.Table("Rows", {
    instance: instance.name,
    columnFamilies: { cf: { gcRule: { maxNumVersions: 1 } } },
  });
});

/** Table the generated table-level bindings bind. */
export const GenRows = Effect.gen(function* () {
  const instance = yield* Db;
  return yield* GCP.Bigtable.Table("GenRows", {
    instance: instance.name,
    columnFamilies: { cf: { gcRule: { maxNumVersions: 1 } } },
  });
});

/** A backup of {@link GenRows} the copy, restore and backup-read bindings use. */
export const GenBackup = Effect.gen(function* () {
  const instance = yield* Db;
  const table = yield* GenRows;
  return yield* GCP.Bigtable.InstancesClustersBackup("GenBackup", {
    instance: instance.name,
    cluster: "cluster",
    sourceTable: table.name,
  });
});

/**
 * Effect-native Cloud Run service exercising every Bigtable binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */

/** Bucket the audit-log consumers record entries in. */
export const AuditMarkers = GCP.Storage.Bucket("AuditMarkers", {
  location: "US-CENTRAL1",
  forceDestroy: true,
});

export default class BigtableBindingsHost extends GCP.Function<BigtableBindingsHost>()(
  "BigtableBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const putMarker = yield* GCP.Storage.PutObject(AuditMarkers);
    yield* GCP.Bigtable.consumeInstanceAuditLogs(
      Db,
      { methods: ["SetIamPolicy"] },
      recordAuditLogs("instance", putMarker),
    );
    yield* GCP.Bigtable.consumeTableAuditLogs(
      GenRows,
      { methods: ["SetIamPolicy"] },
      recordAuditLogs("table", putMarker),
    );
    const getInstance = yield* GCP.Bigtable.GetInstance(Db);
    const getCluster = yield* GCP.Bigtable.GetCluster(Nodes);
    const getTable = yield* GCP.Bigtable.GetTable(Rows);

    const B = GCP.Bigtable;
    const checkConsistency = yield* B.CheckTableConsistency(GenRows);
    const generateToken = yield* B.GenerateTableConsistencyToken(GenRows);
    const dropRowRange = yield* B.DropTableRowRange(GenRows);
    const modifyColumnFamilies = yield* B.ModifyTableColumnFamilies(GenRows);
    const undelete = yield* B.UndeleteTable(GenRows);
    const listAuthorizedViews = yield* B.ListTableAuthorizedViews(GenRows);
    const getAuthorizedView = yield* B.GetTableAuthorizedView(GenRows);
    const listSchemaBundles = yield* B.ListTableSchemaBundles(GenRows);
    const getSchemaBundle = yield* B.GetTableSchemaBundle(GenRows);
    const listAppProfiles = yield* B.ListInstanceAppProfiles(Db);
    const getAppProfile = yield* B.GetInstanceAppProfile(Db);
    const listClusters = yield* B.ListInstanceClusters(Db);
    const listTables = yield* B.ListInstanceTables(Db);
    const listBackups = yield* B.ListInstanceClusterBackups(Db);
    const getBackup = yield* B.GetInstanceClusterBackup(Db);
    const copyBackup = yield* B.CopyInstanceClusterBackup(Db);
    const listHotTablets = yield* B.ListInstanceClusterHotTablets(Db);
    const listMemoryLayers = yield* B.ListInstanceClusterMemoryLayers(Db);
    const listLogicalViews = yield* B.ListInstanceLogicalViews(Db);
    const getLogicalView = yield* B.GetInstanceLogicalView(Db);
    const listMaterializedViews = yield* B.ListInstanceMaterializedViews(Db);
    const getMaterializedView = yield* B.GetInstanceMaterializedView(Db);
    const restore = yield* B.RestoreInstanceTable(Db);

    return {
      fetch: serveProbes({
        getInstance: getInstance(),
        getCluster: getCluster(),
        getTable: getTable(),
        consistency: Effect.gen(function* () {
          const { consistencyToken } = yield* generateToken({ body: {} });
          return yield* checkConsistency({ body: { consistencyToken } });
        }),
        dropRowRange: dropRowRange({ body: { deleteAllDataFromTable: true } }),
        // Drop and recreate in one call, so a rerun against a table that kept `extra` still works.
        addFamily: modifyColumnFamilies({
          body: {
            modifications: [
              { id: "extra", drop: true },
              { id: "extra", create: { gcRule: { maxNumVersions: 1 } } },
            ],
          },
        }).pipe(
          Effect.catchTag("NotFound", () =>
            modifyColumnFamilies({
              body: {
                modifications: [{ id: "extra", create: { gcRule: { maxNumVersions: 1 } } }],
              },
            }),
          ),
        ),
        // The table isn't deleted, so there is nothing to undelete.
        undelete: outcome(undelete({ body: {} })),
        tableChildren: Effect.all({
          authorizedViews: listAuthorizedViews(),
          missingAuthorizedView: outcome(getAuthorizedView({ authorizedView: "none" })),
          schemaBundles: listSchemaBundles(),
          missingSchemaBundle: outcome(getSchemaBundle({ schemaBundle: "none" })),
        }),
        instance: Effect.all({
          appProfiles: listAppProfiles(),
          defaultProfile: getAppProfile({ appProfile: "default" }),
          clusters: listClusters(),
          tables: listTables(),
          hotTablets: listHotTablets({ cluster: "cluster" }),
          memoryLayers: outcome(listMemoryLayers({ cluster: "cluster" })),
          logicalViews: listLogicalViews(),
          missingLogicalView: outcome(getLogicalView({ logicalView: "none" })),
          materializedViews: listMaterializedViews(),
          missingMaterializedView: outcome(getMaterializedView({ materializedView: "none" })),
        }),
        backups: Effect.gen(function* () {
          const listed = yield* listBackups({ cluster: "cluster" });
          const backup = listed.backups?.[0]?.name?.split("/").at(-1) ?? "";
          return { listed, backup: yield* getBackup({ cluster: "cluster", backup }) };
        }),
        // `?backup=` is the source backup's full name; `?id=` the new backup or table.
        copyBackup: Effect.gen(function* () {
          const sourceBackup = yield* probeParam("backup");
          const backupId = yield* probeParam("id");
          const expireTime = yield* Effect.sync(() =>
            new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
          );
          return yield* copyBackup({
            cluster: "cluster",
            body: { backupId, sourceBackup, expireTime },
          });
        }),
        restoreTable: Effect.gen(function* () {
          const backup = yield* probeParam("backup");
          const tableId = yield* probeParam("id");
          return yield* restore({ body: { tableId, backup } });
        }),
      }),
    };
  }).pipe(
    Effect.provide(GCP.Bigtable.GetInstanceHttp),
    Effect.provide(GCP.Bigtable.GetClusterHttp),
    Effect.provide(GCP.Bigtable.GetTableHttp),
    Effect.provide(
      Layer.mergeAll(
        GCP.Logging.AuditLogEventSourceLive.pipe(Layer.provideMerge(GCP.Run.TopicEventSource)),
        GCP.Storage.PutObjectHttp,
        GCP.Bigtable.CheckTableConsistencyHttp,
        GCP.Bigtable.GenerateTableConsistencyTokenHttp,
        GCP.Bigtable.DropTableRowRangeHttp,
        GCP.Bigtable.ModifyTableColumnFamiliesHttp,
        GCP.Bigtable.UndeleteTableHttp,
        GCP.Bigtable.ListTableAuthorizedViewsHttp,
        GCP.Bigtable.GetTableAuthorizedViewHttp,
        GCP.Bigtable.ListTableSchemaBundlesHttp,
        GCP.Bigtable.GetTableSchemaBundleHttp,
        GCP.Bigtable.ListInstanceAppProfilesHttp,
        GCP.Bigtable.GetInstanceAppProfileHttp,
        GCP.Bigtable.ListInstanceClustersHttp,
        GCP.Bigtable.ListInstanceTablesHttp,
        GCP.Bigtable.ListInstanceClusterBackupsHttp,
        GCP.Bigtable.GetInstanceClusterBackupHttp,
        GCP.Bigtable.CopyInstanceClusterBackupHttp,
        GCP.Bigtable.ListInstanceClusterHotTabletsHttp,
        GCP.Bigtable.ListInstanceClusterMemoryLayersHttp,
        GCP.Bigtable.ListInstanceLogicalViewsHttp,
        GCP.Bigtable.GetInstanceLogicalViewHttp,
        GCP.Bigtable.ListInstanceMaterializedViewsHttp,
        GCP.Bigtable.GetInstanceMaterializedViewHttp,
        GCP.Bigtable.RestoreInstanceTableHttp,
      ),
    ),
  ),
) {}
