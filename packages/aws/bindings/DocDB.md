<!-- Docs for the generated AWS.DocDB bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## ApplyPendingMaintenanceAction

Runtime binding for the `ApplyPendingMaintenanceAction` operation (IAM
action `rds:ApplyPendingMaintenanceAction` — DocumentDB shares the RDS
control plane).

Opts a DocumentDB cluster or instance into a pending maintenance action
(`system-update`, `db-upgrade`, `ca-certificate-rotation`) immediately or
at the next maintenance window — the apply half of maintenance
automation. The target is an ARN carried in the request, so the grant
spans the account. Provide the implementation with
`Effect.provide(AWS.DocDB.ApplyPendingMaintenanceActionHttp)`.
### Maintenance
**Example:** Apply Maintenance at the Next Window
```typescript
const applyPending = yield* DocDB.ApplyPendingMaintenanceAction();

yield* applyPending({
  ResourceIdentifier: clusterArn,
  ApplyAction: "system-update",
  OptInType: "next-maintenance",
});
```

@binding

## CopyDBClusterSnapshot

Runtime binding for the `CopyDBClusterSnapshot` operation (IAM action
`rds:CopyDBClusterSnapshot` — DocumentDB shares the RDS control plane).

Copies a DocumentDB cluster snapshot — to a new name, another KMS key, or
(with a pre-signed URL) another region — the core of snapshot fan-out and
DR automation. Source and target identifiers are runtime data, so the
grant spans the account's `cluster-snapshot` ARNs. Provide the
implementation with `Effect.provide(AWS.DocDB.CopyDBClusterSnapshotHttp)`.
### Managing Snapshots
**Example:** Copy a Snapshot to an Archive Name
```typescript
const copySnapshot = yield* DocDB.CopyDBClusterSnapshot();

yield* copySnapshot({
  SourceDBClusterSnapshotIdentifier: "nightly-2026-07-15",
  TargetDBClusterSnapshotIdentifier: "archive-2026-07-15",
});
```

@binding

## CreateDBClusterSnapshot

Runtime binding for the `CreateDBClusterSnapshot` operation (IAM action
`rds:CreateDBClusterSnapshot`).

Takes an on-demand snapshot of the bound {@link DBCluster} — e.g. a backup
function that snapshots before a risky migration. The cluster identifier
is injected from the binding; the grant covers both the cluster ARN and
the account's `cluster-snapshot` ARN space (both resources must be allowed
for snapshot creation). Provide the implementation with
`Effect.provide(AWS.DocDB.CreateDBClusterSnapshotHttp)`.
### Operating a Cluster
**Example:** Snapshot Before a Migration
```typescript
// init — bind the operation to the cluster
const createDBClusterSnapshot =
  yield* AWS.DocDB.CreateDBClusterSnapshot(cluster);

// runtime
const { DBClusterSnapshot } = yield* createDBClusterSnapshot({
  DBClusterSnapshotIdentifier: `pre-migration-${runId}`,
});
```

@binding

## DeleteDBClusterSnapshot

Runtime binding for the `DeleteDBClusterSnapshot` operation (IAM action
`rds:DeleteDBClusterSnapshot` — DocumentDB shares the RDS control plane).

Deletes a DocumentDB cluster snapshot by identifier — the retention half
of snapshot-rotation automation (create nightly, prune the oldest).
Snapshot identifiers are runtime data, so the grant spans the account's
`cluster-snapshot` ARNs. Provide the implementation with
`Effect.provide(AWS.DocDB.DeleteDBClusterSnapshotHttp)`.
### Managing Snapshots
**Example:** Prune an Expired Snapshot
```typescript
const deleteSnapshot = yield* DocDB.DeleteDBClusterSnapshot();

yield* deleteSnapshot({
  DBClusterSnapshotIdentifier: "nightly-2026-06-01",
}).pipe(
  // already gone — rotation is idempotent
  Effect.catchTag("DBClusterSnapshotNotFoundFault", () => Effect.void),
);
```

@binding

## DescribeDBClusterSnapshots

Runtime binding for the `DescribeDBClusterSnapshots` operation (IAM
action `rds:DescribeDBClusterSnapshots` — DocumentDB shares the RDS
control plane).

Lists the account's DocumentDB cluster snapshots (optionally filtered by
cluster or snapshot identifier) with status and creation time embedded —
pairs with `CreateDBClusterSnapshot`/`DeleteDBClusterSnapshot` for backup
automation. Provide the implementation with
`Effect.provide(AWS.DocDB.DescribeDBClusterSnapshotsHttp)`.
### Managing Snapshots
**Example:** Poll a Snapshot until Available
```typescript
const describeSnapshots = yield* DocDB.DescribeDBClusterSnapshots();

const page = yield* describeSnapshots({
  DBClusterSnapshotIdentifier: "nightly-2026-07-15",
});
const status = page.DBClusterSnapshots?.[0]?.Status;
```

@binding

## DescribeDBClusters

Runtime binding for the `DescribeDBClusters` operation (IAM action
`rds:DescribeDBClusters`).

Lists the account's DocumentDB clusters (or one cluster by identifier) —
status, endpoints, members, engine versions — for health checks and
cluster discovery. Provide the implementation with
`Effect.provide(AWS.DocDB.DescribeDBClustersHttp)`.
### Monitoring Clusters
**Example:** Check a Cluster's Status
```typescript
const describeDBClusters = yield* AWS.DocDB.DescribeDBClusters();

const page = yield* describeDBClusters({
  DBClusterIdentifier: clusterId,
});
const status = page.DBClusters?.[0]?.Status;
```

@binding

## DescribeDBInstances

Runtime binding for the `DescribeDBInstances` operation (IAM action
`rds:DescribeDBInstances` — DocumentDB shares the RDS control plane).

Lists the account's DocumentDB instances (optionally filtered by
identifier or cluster) with status, endpoint, and class embedded — the
building block of instance-health monitoring and reboot automation.
Provide the implementation with
`Effect.provide(AWS.DocDB.DescribeDBInstancesHttp)`.
### Monitoring Instances
**Example:** Check the Cluster's Instance Health
```typescript
const describeDBInstances = yield* DocDB.DescribeDBInstances();

const page = yield* describeDBInstances({
  Filters: [{ Name: "db-cluster-id", Values: [clusterId] }],
});
const available = page.DBInstances?.filter(
  (instance) => instance.DBInstanceStatus === "available",
);
```

@binding

## DescribeEvents

Runtime binding for the `DescribeEvents` operation (IAM action
`rds:DescribeEvents`).

Returns events related to DocumentDB clusters, instances, snapshots, and
parameter groups from the last 24 hours (up to 14 days with an explicit
time window) — failovers, maintenance, configuration changes. Provide the
implementation with `Effect.provide(AWS.DocDB.DescribeEventsHttp)`.
### Monitoring Clusters
**Example:** Read a Cluster's Recent Events
```typescript
const describeEvents = yield* AWS.DocDB.DescribeEvents();

const page = yield* describeEvents({
  SourceIdentifier: clusterId,
  SourceType: "db-cluster",
});
for (const event of page.Events ?? []) {
  yield* Effect.logInfo(`${event.Date}: ${event.Message}`);
}
```

@binding

## DescribePendingMaintenanceActions

Runtime binding for the `DescribePendingMaintenanceActions` operation
(IAM action `rds:DescribePendingMaintenanceActions` — DocumentDB shares
the RDS control plane).

Lists pending maintenance actions (engine patches, certificate
rotations) across the account's DocumentDB clusters and instances —
pairs with `ApplyPendingMaintenanceAction` for maintenance automation.
Provide the implementation with
`Effect.provide(AWS.DocDB.DescribePendingMaintenanceActionsHttp)`.
### Maintenance
**Example:** List Pending Maintenance across the Account
```typescript
const describePending = yield* DocDB.DescribePendingMaintenanceActions();

const page = yield* describePending();
for (const resource of page.PendingMaintenanceActions ?? []) {
  yield* Effect.log(
    `${resource.ResourceIdentifier}: ${resource.PendingMaintenanceActionDetails?.length} pending`,
  );
}
```

@binding

## FailoverDBCluster

Runtime binding for the `FailoverDBCluster` operation (IAM action
`rds:FailoverDBCluster`).

Forces a failover of the bound {@link DBCluster} — one of the replicas is
promoted to primary — for resilience testing or to move the writer to a
specific instance. The cluster identifier is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DocDB.FailoverDBClusterHttp)`.
### Operating a Cluster
**Example:** Force a Failover
```typescript
// init — bind the operation to the cluster
const failoverDBCluster = yield* AWS.DocDB.FailoverDBCluster(cluster);

// runtime — promote a specific replica
yield* failoverDBCluster({
  TargetDBInstanceIdentifier: replicaId,
});
```

@binding

## RebootDBInstance

Runtime binding for the `RebootDBInstance` operation (IAM action
`rds:RebootDBInstance`).

Reboots the bound {@link DBInstance} — e.g. an ops function applying a
parameter-group change that requires a restart. The instance identifier
is injected from the binding. Provide the implementation with
`Effect.provide(AWS.DocDB.RebootDBInstanceHttp)`.
### Operating an Instance
**Example:** Reboot an Instance
```typescript
// init — bind the operation to the instance
const rebootDBInstance = yield* AWS.DocDB.RebootDBInstance(instance);

// runtime — optionally force a failover during the reboot
yield* rebootDBInstance({ ForceFailover: false });
```

@binding

## StartDBCluster

Runtime binding for the `StartDBCluster` operation (IAM action
`rds:StartDBCluster`).

Starts the bound {@link DBCluster} after it was stopped — e.g. an ops
function that wakes a development cluster on a schedule. The cluster
identifier is injected from the binding. Provide the implementation with
`Effect.provide(AWS.DocDB.StartDBClusterHttp)`.
### Operating a Cluster
**Example:** Start a Stopped Cluster
```typescript
// init — bind the operation to the cluster
const startDBCluster = yield* AWS.DocDB.StartDBCluster(cluster);

// runtime
yield* startDBCluster();
```

@binding

## StopDBCluster

Runtime binding for the `StopDBCluster` operation (IAM action
`rds:StopDBCluster`).

Stops the bound {@link DBCluster} — compute billing pauses while storage
is retained (up to 7 days, after which DocumentDB starts it back up) —
e.g. an ops function that parks a development cluster overnight. The
cluster identifier is injected from the binding. Provide the
implementation with `Effect.provide(AWS.DocDB.StopDBClusterHttp)`.
### Operating a Cluster
**Example:** Stop a Running Cluster
```typescript
// init — bind the operation to the cluster
const stopDBCluster = yield* AWS.DocDB.StopDBCluster(cluster);

// runtime
yield* stopDBCluster();
```

@binding
