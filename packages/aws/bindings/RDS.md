<!-- Docs for the generated AWS.RDS bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## ApplyPendingMaintenanceAction

Runtime binding for the `ApplyPendingMaintenanceAction` operation (IAM action
`rds:ApplyPendingMaintenanceAction`).

Applies (or schedules) a pending maintenance action on an RDS resource
— e.g. an ops function that rolls maintenance during a controlled window. Provide the implementation with
`Effect.provide(AWS.RDS.ApplyPendingMaintenanceActionHttp)`.
### Maintenance
**Example:** Apply Maintenance Immediately
```typescript
const applyPendingMaintenanceAction =
  yield* AWS.RDS.ApplyPendingMaintenanceAction();

yield* applyPendingMaintenanceAction({
  ResourceIdentifier: clusterArn,
  ApplyAction: "system-update",
  OptInType: "immediate",
});
```

@binding

## CopyDBClusterSnapshot

Runtime binding for the `CopyDBClusterSnapshot` operation (IAM actions
`rds:CopyDBClusterSnapshot` +
`rds:AddTagsToResource`).

Copies an Aurora cluster snapshot (e.g. to archive it under a new
identifier or re-encrypt with a different KMS key). Provide the implementation with
`Effect.provide(AWS.RDS.CopyDBClusterSnapshotHttp)`.
### Managing Cluster Snapshots
**Example:** Archive a Cluster Snapshot
```typescript
const copyDBClusterSnapshot = yield* AWS.RDS.CopyDBClusterSnapshot();

yield* copyDBClusterSnapshot({
  SourceDBClusterSnapshotIdentifier: snapshotId,
  TargetDBClusterSnapshotIdentifier: `archive-${snapshotId}`,
});
```

@binding

## CopyDBSnapshot

Runtime binding for the `CopyDBSnapshot` operation (IAM actions
`rds:CopyDBSnapshot` +
`rds:AddTagsToResource`).

Copies a DB instance snapshot (e.g. to archive it under a new
identifier or re-encrypt with a different KMS key). Provide the implementation with
`Effect.provide(AWS.RDS.CopyDBSnapshotHttp)`.
### Managing Instance Snapshots
**Example:** Archive an Instance Snapshot
```typescript
const copyDBSnapshot = yield* AWS.RDS.CopyDBSnapshot();

yield* copyDBSnapshot({
  SourceDBSnapshotIdentifier: snapshotId,
  TargetDBSnapshotIdentifier: `archive-${snapshotId}`,
});
```

@binding

## CreateDBClusterSnapshot

Runtime binding for the `CreateDBClusterSnapshot` operation (IAM actions
`rds:CreateDBClusterSnapshot` +
`rds:AddTagsToResource`).

Takes a manual snapshot of the bound {@link DBCluster} — e.g. a
pre-migration backup function or a scheduled snapshot-rotation job. The
cluster identifier is injected from the binding. Provide the implementation with
`Effect.provide(AWS.RDS.CreateDBClusterSnapshotHttp)`.
### Managing Cluster Snapshots
**Example:** Take a Manual Cluster Snapshot
```typescript
// init — bind the operation to the cluster
const createDBClusterSnapshot =
  yield* AWS.RDS.CreateDBClusterSnapshot(cluster);

// runtime
yield* createDBClusterSnapshot({
  DBClusterSnapshotIdentifier: `pre-migration-${runId}`,
});
```

@binding

## CreateDBSnapshot

Runtime binding for the `CreateDBSnapshot` operation (IAM actions
`rds:CreateDBSnapshot` +
`rds:AddTagsToResource`).

Takes a manual snapshot of the bound {@link DBInstance} — e.g. a
pre-migration backup function or a scheduled snapshot-rotation job. The
instance identifier is injected from the binding. Provide the implementation with
`Effect.provide(AWS.RDS.CreateDBSnapshotHttp)`.
### Managing Instance Snapshots
**Example:** Take a Manual Instance Snapshot
```typescript
// init — bind the operation to the instance
const createDBSnapshot = yield* AWS.RDS.CreateDBSnapshot(instance);

// runtime
yield* createDBSnapshot({
  DBSnapshotIdentifier: `pre-migration-${runId}`,
});
```

@binding

## DeleteDBClusterSnapshot

Runtime binding for the `DeleteDBClusterSnapshot` operation (IAM action
`rds:DeleteDBClusterSnapshot`).

Deletes a manual Aurora cluster snapshot — the pruning half of a
snapshot-rotation function. Provide the implementation with
`Effect.provide(AWS.RDS.DeleteDBClusterSnapshotHttp)`.
### Managing Cluster Snapshots
**Example:** Prune an Old Cluster Snapshot
```typescript
const deleteDBClusterSnapshot = yield* AWS.RDS.DeleteDBClusterSnapshot();

yield* deleteDBClusterSnapshot({
  DBClusterSnapshotIdentifier: oldSnapshotId,
});
```

@binding

## DeleteDBSnapshot

Runtime binding for the `DeleteDBSnapshot` operation (IAM action
`rds:DeleteDBSnapshot`).

Deletes a manual DB instance snapshot — the pruning half of a
snapshot-rotation function. Provide the implementation with
`Effect.provide(AWS.RDS.DeleteDBSnapshotHttp)`.
### Managing Instance Snapshots
**Example:** Prune an Old Instance Snapshot
```typescript
const deleteDBSnapshot = yield* AWS.RDS.DeleteDBSnapshot();

yield* deleteDBSnapshot({ DBSnapshotIdentifier: oldSnapshotId });
```

@binding

## DescribeDBClusterEndpoints

Runtime binding for the `DescribeDBClusterEndpoints` operation (IAM action
`rds:DescribeDBClusterEndpoints`).

Lists an Aurora cluster's endpoints (writer, reader, and custom
endpoints) with their status and member lists. Provide the implementation with
`Effect.provide(AWS.RDS.DescribeDBClusterEndpointsHttp)`.
### Monitoring Databases
**Example:** List a Cluster's Endpoints
```typescript
const describeDBClusterEndpoints =
  yield* AWS.RDS.DescribeDBClusterEndpoints();

const page = yield* describeDBClusterEndpoints({
  DBClusterIdentifier: clusterId,
});
```

@binding

## DescribeDBClusterSnapshots

Runtime binding for the `DescribeDBClusterSnapshots` operation (IAM action
`rds:DescribeDBClusterSnapshots`).

Lists the account's Aurora cluster snapshots — the discovery half of a
snapshot-rotation or verification function. Provide the implementation with
`Effect.provide(AWS.RDS.DescribeDBClusterSnapshotsHttp)`.
### Managing Cluster Snapshots
**Example:** List a Cluster's Manual Snapshots
```typescript
const describeDBClusterSnapshots =
  yield* AWS.RDS.DescribeDBClusterSnapshots();

const page = yield* describeDBClusterSnapshots({
  DBClusterIdentifier: clusterId,
  SnapshotType: "manual",
});
```

@binding

## DescribeDBClusters

Runtime binding for the `DescribeDBClusters` operation (IAM action
`rds:DescribeDBClusters`).

Lists the account's RDS/Aurora clusters (or one cluster by identifier) —
status, endpoints, members, engine versions — for health checks and
cluster discovery. Provide the implementation with
`Effect.provide(AWS.RDS.DescribeDBClustersHttp)`.
### Monitoring Databases
**Example:** Check a Cluster's Status
```typescript
const describeDBClusters = yield* AWS.RDS.DescribeDBClusters();

const page = yield* describeDBClusters({
  DBClusterIdentifier: clusterId,
});
const status = page.DBClusters?.[0]?.Status;
```

@binding

## DescribeDBInstances

Runtime binding for the `DescribeDBInstances` operation (IAM action
`rds:DescribeDBInstances`).

Lists the account's RDS instances (or one instance by identifier) —
status, endpoint, storage, engine version — for health checks and
instance discovery. Provide the implementation with
`Effect.provide(AWS.RDS.DescribeDBInstancesHttp)`.
### Monitoring Databases
**Example:** Check an Instance's Status
```typescript
const describeDBInstances = yield* AWS.RDS.DescribeDBInstances();

const page = yield* describeDBInstances({
  DBInstanceIdentifier: instanceId,
});
const status = page.DBInstances?.[0]?.DBInstanceStatus;
```

@binding

## DescribeDBSnapshots

Runtime binding for the `DescribeDBSnapshots` operation (IAM action
`rds:DescribeDBSnapshots`).

Lists the account's DB instance snapshots — the discovery half of a
snapshot-rotation or verification function. Provide the implementation with
`Effect.provide(AWS.RDS.DescribeDBSnapshotsHttp)`.
### Managing Instance Snapshots
**Example:** List an Instance's Manual Snapshots
```typescript
const describeDBSnapshots = yield* AWS.RDS.DescribeDBSnapshots();

const page = yield* describeDBSnapshots({
  DBInstanceIdentifier: instanceId,
  SnapshotType: "manual",
});
```

@binding

## DescribeEvents

Runtime binding for the `DescribeEvents` operation (IAM action
`rds:DescribeEvents`).

Lists recent RDS events (instance/cluster/snapshot/parameter-group
lifecycle notifications from the last 14 days) — the pull-based
counterpart to {@link consumeRdsEvents}. Provide the implementation with
`Effect.provide(AWS.RDS.DescribeEventsHttp)`.
### Monitoring Databases
**Example:** List Recent Events for a Cluster
```typescript
const describeEvents = yield* AWS.RDS.DescribeEvents();

const page = yield* describeEvents({
  SourceType: "db-cluster",
  SourceIdentifier: clusterId,
});
```

@binding

## DescribePendingMaintenanceActions

Runtime binding for the `DescribePendingMaintenanceActions` operation (IAM action
`rds:DescribePendingMaintenanceActions`).

Lists pending maintenance actions (engine upgrades, OS patches,
certificate rotations) across the account's RDS resources. Provide the implementation with
`Effect.provide(AWS.RDS.DescribePendingMaintenanceActionsHttp)`.
### Maintenance
**Example:** List Pending Maintenance
```typescript
const describePendingMaintenanceActions =
  yield* AWS.RDS.DescribePendingMaintenanceActions();

const page = yield* describePendingMaintenanceActions();
```

@binding

## FailoverDBCluster

Runtime binding for the `FailoverDBCluster` operation (IAM action
`rds:FailoverDBCluster`).

Forces a failover of the bound {@link DBCluster} — promotes a reader to
writer, e.g. for chaos testing or AZ evacuation. The cluster identifier
is injected from the binding. Provide the implementation with
`Effect.provide(AWS.RDS.FailoverDBClusterHttp)`.
### Operating a Cluster
**Example:** Force a Failover
```typescript
// init — bind the operation to the cluster
const failoverDBCluster = yield* AWS.RDS.FailoverDBCluster(cluster);

// runtime
yield* failoverDBCluster();
```

@binding

## RebootDBInstance

Runtime binding for the `RebootDBInstance` operation (IAM action
`rds:RebootDBInstance`).

Reboots the bound {@link DBInstance} (optionally with a forced
failover for Multi-AZ deployments) — e.g. to apply static parameter
changes. The instance identifier is injected from the binding. Provide the implementation with
`Effect.provide(AWS.RDS.RebootDBInstanceHttp)`.
### Operating an Instance
**Example:** Reboot an Instance
```typescript
// init — bind the operation to the instance
const rebootDBInstance = yield* AWS.RDS.RebootDBInstance(instance);

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
`Effect.provide(AWS.RDS.StartDBClusterHttp)`.
### Operating a Cluster
**Example:** Start a Stopped Cluster
```typescript
// init — bind the operation to the cluster
const startDBCluster = yield* AWS.RDS.StartDBCluster(cluster);

// runtime
yield* startDBCluster();
```

@binding

## StartDBInstance

Runtime binding for the `StartDBInstance` operation (IAM action
`rds:StartDBInstance`).

Starts the bound {@link DBInstance} after it was stopped — e.g. an ops
function that wakes a development database on a schedule. The instance
identifier is injected from the binding. Provide the implementation with
`Effect.provide(AWS.RDS.StartDBInstanceHttp)`.
### Operating an Instance
**Example:** Start a Stopped Instance
```typescript
// init — bind the operation to the instance
const startDBInstance = yield* AWS.RDS.StartDBInstance(instance);

// runtime
yield* startDBInstance();
```

@binding

## StopDBCluster

Runtime binding for the `StopDBCluster` operation (IAM action
`rds:StopDBCluster`).

Stops the bound {@link DBCluster} — e.g. an ops function that parks a
development cluster overnight to save cost. The cluster identifier is
injected from the binding. Provide the implementation with
`Effect.provide(AWS.RDS.StopDBClusterHttp)`.
### Operating a Cluster
**Example:** Stop a Running Cluster
```typescript
// init — bind the operation to the cluster
const stopDBCluster = yield* AWS.RDS.StopDBCluster(cluster);

// runtime
yield* stopDBCluster();
```

@binding

## StopDBInstance

Runtime binding for the `StopDBInstance` operation (IAM action
`rds:StopDBInstance`).

Stops the bound {@link DBInstance} — e.g. an ops function that parks a
development database overnight to save cost. The instance identifier is
injected from the binding. Provide the implementation with
`Effect.provide(AWS.RDS.StopDBInstanceHttp)`.
### Operating an Instance
**Example:** Stop a Running Instance
```typescript
// init — bind the operation to the instance
const stopDBInstance = yield* AWS.RDS.StopDBInstance(instance);

// runtime
yield* stopDBInstance();
```

@binding
