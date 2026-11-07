<!-- Docs for the generated AWS.Neptune bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## ApplyPendingMaintenanceAction

Runtime binding for the `ApplyPendingMaintenanceAction` operation (IAM
action `rds:ApplyPendingMaintenanceAction`).

Opts a Neptune resource (by ARN) into a pending maintenance action — e.g.
apply an engine patch during the next maintenance window, or immediately.
Provide the implementation with
`Effect.provide(AWS.Neptune.ApplyPendingMaintenanceActionHttp)`.
### Maintenance
**Example:** Apply Maintenance at the Next Window
```typescript
const applyPendingMaintenanceAction =
  yield* AWS.Neptune.ApplyPendingMaintenanceAction();

yield* applyPendingMaintenanceAction({
  ResourceIdentifier: clusterArn,
  ApplyAction: "system-update",
  OptInType: "next-maintenance",
});
```

@binding

## CopyDBClusterSnapshot

Runtime binding for the `CopyDBClusterSnapshot` operation (IAM action
`rds:CopyDBClusterSnapshot`).

Copies a Neptune cluster snapshot — e.g. archive a nightly snapshot under
a retention prefix, or copy it for cross-region disaster recovery. Provide
the implementation with
`Effect.provide(AWS.Neptune.CopyDBClusterSnapshotHttp)`.
### Managing Snapshots
**Example:** Archive a Snapshot
```typescript
const copyDBClusterSnapshot = yield* AWS.Neptune.CopyDBClusterSnapshot();

yield* copyDBClusterSnapshot({
  SourceDBClusterSnapshotIdentifier: snapshotId,
  TargetDBClusterSnapshotIdentifier: `${snapshotId}-archive`,
});
```

@binding

## CreateDBClusterSnapshot

Runtime binding for the `CreateDBClusterSnapshot` operation (IAM actions
`rds:CreateDBClusterSnapshot` + `rds:AddTagsToResource`).

Takes a manual snapshot of the bound {@link DBCluster} — e.g. a
pre-migration backup function or a scheduled snapshot-rotation job. The
cluster identifier is injected from the binding. Provide the
implementation with
`Effect.provide(AWS.Neptune.CreateDBClusterSnapshotHttp)`.
### Managing Snapshots
**Example:** Take a Manual Snapshot
```typescript
// init — bind the operation to the cluster
const createDBClusterSnapshot =
  yield* AWS.Neptune.CreateDBClusterSnapshot(cluster);

// runtime
yield* createDBClusterSnapshot({
  DBClusterSnapshotIdentifier: `pre-migration-${runId}`,
});
```

@binding

## DeleteDBClusterSnapshot

Runtime binding for the `DeleteDBClusterSnapshot` operation (IAM action
`rds:DeleteDBClusterSnapshot`).

Deletes a manual Neptune cluster snapshot — the pruning half of a
snapshot-rotation function. Provide the implementation with
`Effect.provide(AWS.Neptune.DeleteDBClusterSnapshotHttp)`.
### Managing Snapshots
**Example:** Prune an Old Snapshot
```typescript
const deleteDBClusterSnapshot = yield* AWS.Neptune.DeleteDBClusterSnapshot();

yield* deleteDBClusterSnapshot({
  DBClusterSnapshotIdentifier: oldSnapshotId,
});
```

@binding

## DescribeDBClusterEndpoints

Runtime binding for the `DescribeDBClusterEndpoints` operation (IAM action
`rds:DescribeDBClusterEndpoints`).

Lists a Neptune cluster's endpoints — the writer, reader, and any custom
endpoints — so a function can discover the host names to route Gremlin or
openCypher traffic to. Provide the implementation with
`Effect.provide(AWS.Neptune.DescribeDBClusterEndpointsHttp)`.
### Monitoring Clusters
**Example:** Discover a Cluster's Endpoints
```typescript
const describeDBClusterEndpoints =
  yield* AWS.Neptune.DescribeDBClusterEndpoints();

const page = yield* describeDBClusterEndpoints({
  DBClusterIdentifier: clusterId,
});
const endpoints = page.DBClusterEndpoints?.map((e) => e.Endpoint);
```

@binding

## DescribeDBClusterSnapshots

Runtime binding for the `DescribeDBClusterSnapshots` operation (IAM action
`rds:DescribeDBClusterSnapshots`).

Lists the account's Neptune cluster snapshots (manual and automated) —
for backup verification and restore tooling. Provide the implementation
with `Effect.provide(AWS.Neptune.DescribeDBClusterSnapshotsHttp)`.
### Managing Snapshots
**Example:** List a Cluster's Snapshots
```typescript
const describeDBClusterSnapshots =
  yield* AWS.Neptune.DescribeDBClusterSnapshots();

const page = yield* describeDBClusterSnapshots({
  DBClusterIdentifier: clusterId,
});
const count = page.DBClusterSnapshots?.length;
```

@binding

## DescribeDBClusters

Runtime binding for the `DescribeDBClusters` operation (IAM action
`rds:DescribeDBClusters`).

Lists the account's Neptune clusters (or one cluster by identifier) —
status, endpoints, members, engine versions — for health checks and
cluster discovery. Provide the implementation with
`Effect.provide(AWS.Neptune.DescribeDBClustersHttp)`.
### Monitoring Clusters
**Example:** Check a Cluster's Status
```typescript
const describeDBClusters = yield* AWS.Neptune.DescribeDBClusters();

const page = yield* describeDBClusters({
  DBClusterIdentifier: clusterId,
});
const status = page.DBClusters?.[0]?.Status;
```

@binding

## DescribeDBInstances

Runtime binding for the `DescribeDBInstances` operation (IAM action
`rds:DescribeDBInstances`).

Lists the account's Neptune instances (or one instance by identifier) —
status, endpoint, instance class, cluster membership — for health checks
and reader discovery. Provide the implementation with
`Effect.provide(AWS.Neptune.DescribeDBInstancesHttp)`.
### Monitoring Clusters
**Example:** Check an Instance's Status
```typescript
const describeDBInstances = yield* AWS.Neptune.DescribeDBInstances();

const page = yield* describeDBInstances({
  DBInstanceIdentifier: instanceId,
});
const status = page.DBInstances?.[0]?.DBInstanceStatus;
```

@binding

## DescribeEvents

Runtime binding for the `DescribeEvents` operation (IAM action
`rds:DescribeEvents`).

Lists recent events (failovers, maintenance, snapshots, parameter changes)
for the account's Neptune clusters and instances — the audit trail for
operational tooling. Provide the implementation with
`Effect.provide(AWS.Neptune.DescribeEventsHttp)`.
### Monitoring Clusters
**Example:** List a Cluster's Recent Events
```typescript
const describeEvents = yield* AWS.Neptune.DescribeEvents();

const page = yield* describeEvents({
  SourceIdentifier: clusterId,
  SourceType: "db-cluster",
});
const messages = page.Events?.map((e) => e.Message);
```

@binding

## DescribePendingMaintenanceActions

Runtime binding for the `DescribePendingMaintenanceActions` operation (IAM
action `rds:DescribePendingMaintenanceActions`).

Lists pending maintenance actions (engine patches, system updates) for the
account's Neptune resources — pair with
{@link ApplyPendingMaintenanceAction} for maintenance automation. Provide
the implementation with
`Effect.provide(AWS.Neptune.DescribePendingMaintenanceActionsHttp)`.
### Maintenance
**Example:** List Pending Maintenance
```typescript
const describePendingMaintenanceActions =
  yield* AWS.Neptune.DescribePendingMaintenanceActions();

const page = yield* describePendingMaintenanceActions();
const pending = page.PendingMaintenanceActions ?? [];
```

@binding

## FailoverDBCluster

Runtime binding for the `FailoverDBCluster` operation (IAM action
`rds:FailoverDBCluster`).

Forces a failover of the bound {@link DBCluster} — one of the read
replicas is promoted to primary — for resilience testing or to move the
writer to a specific instance. The cluster identifier is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.Neptune.FailoverDBClusterHttp)`.
### Operating a Cluster
**Example:** Force a Failover
```typescript
// init — bind the operation to the cluster
const failoverDBCluster = yield* AWS.Neptune.FailoverDBCluster(cluster);

// runtime — promote a specific replica
yield* failoverDBCluster({
  TargetDBInstanceIdentifier: replicaId,
});
```

@binding

## RebootDBInstance

Runtime binding for the `RebootDBInstance` operation (IAM action
`rds:RebootDBInstance`).

Reboots the bound {@link DBInstance} — e.g. to apply a static parameter
change from an ops function. The instance identifier is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.Neptune.RebootDBInstanceHttp)`.
### Operating a Cluster
**Example:** Reboot an Instance
```typescript
// init — bind the operation to the instance
const rebootDBInstance = yield* AWS.Neptune.RebootDBInstance(instance);

// runtime
yield* rebootDBInstance();
```

@binding

## StartDBCluster

Runtime binding for the `StartDBCluster` operation (IAM action
`rds:StartDBCluster`).

Starts the bound {@link DBCluster} after it was stopped — e.g. an ops
function that wakes a development cluster on a schedule. The cluster
identifier is injected from the binding. Provide the implementation with
`Effect.provide(AWS.Neptune.StartDBClusterHttp)`.
### Operating a Cluster
**Example:** Start a Stopped Cluster
```typescript
// init — bind the operation to the cluster
const startDBCluster = yield* AWS.Neptune.StartDBCluster(cluster);

// runtime
yield* startDBCluster();
```

@binding

## StopDBCluster

Runtime binding for the `StopDBCluster` operation (IAM action
`rds:StopDBCluster`).

Stops the bound {@link DBCluster} (compute pauses, storage persists) —
e.g. an ops function that parks a development cluster overnight to save
cost. The cluster identifier is injected from the binding. Provide the
implementation with `Effect.provide(AWS.Neptune.StopDBClusterHttp)`.
### Operating a Cluster
**Example:** Stop a Running Cluster
```typescript
// init — bind the operation to the cluster
const stopDBCluster = yield* AWS.Neptune.StopDBCluster(cluster);

// runtime
yield* stopDBCluster();
```

@binding
