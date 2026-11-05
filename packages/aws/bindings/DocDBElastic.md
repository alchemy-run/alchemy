<!-- Docs for the generated AWS.DocDBElastic bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## ApplyPendingMaintenanceAction

Runtime binding for the `ApplyPendingMaintenanceAction` operation (IAM
action `docdb-elastic:ApplyPendingMaintenanceAction`).

Opts a resource in to (or out of) a pending maintenance action — apply an
engine update immediately, at the next maintenance window, or undo an
earlier opt-in. Provide the implementation with
`Effect.provide(AWS.DocDBElastic.ApplyPendingMaintenanceActionHttp)`.
### Scheduling Maintenance
**Example:** Apply Maintenance at the Next Window
```typescript
const applyPending = yield* DocDBElastic.ApplyPendingMaintenanceAction();

yield* applyPending({
  resourceArn: cluster.clusterArn,
  applyAction: "ENGINE_UPDATE",
  optInType: "NEXT_MAINTENANCE",
});
```

@binding

## CopyClusterSnapshot

Runtime binding for the `CopyClusterSnapshot` operation (IAM actions
`docdb-elastic:CopyClusterSnapshot` + `docdb-elastic:TagResource`).

Copies an elastic-cluster snapshot — e.g. re-encrypting under a different
KMS key or fanning a nightly backup out under a retention-tagged name.
Provide the implementation with
`Effect.provide(AWS.DocDBElastic.CopyClusterSnapshotHttp)`.
### Managing Snapshots
**Example:** Copy a Snapshot Under a New Name
```typescript
const copySnapshot = yield* DocDBElastic.CopyClusterSnapshot();

const result = yield* copySnapshot({
  snapshotArn,
  targetSnapshotName: "weekly-archive",
  copyTags: true,
});
// result.snapshot.snapshotName → "weekly-archive"
```

@binding

## CreateClusterSnapshot

Runtime binding for the `CreateClusterSnapshot` operation (IAM actions
`docdb-elastic:CreateClusterSnapshot` + `docdb-elastic:TagResource`),
scoped to one {@link Cluster}.

Takes an on-demand manual snapshot of the bound elastic cluster — e.g. a
pre-migration backup from an operational Lambda. Provide the
implementation with
`Effect.provide(AWS.DocDBElastic.CreateClusterSnapshotHttp)`.
### Managing Snapshots
**Example:** Take an On-Demand Snapshot
```typescript
const createSnapshot = yield* DocDBElastic.CreateClusterSnapshot(cluster);

const result = yield* createSnapshot({ snapshotName: "pre-migration" });
// result.snapshot.status → "CREATING"
```

@binding

## DeleteClusterSnapshot

Runtime binding for the `DeleteClusterSnapshot` operation (IAM action
`docdb-elastic:DeleteClusterSnapshot`).

Deletes a manual elastic-cluster snapshot by ARN — e.g. from a Lambda that
prunes on-demand backups past a retention horizon. Provide the
implementation with
`Effect.provide(AWS.DocDBElastic.DeleteClusterSnapshotHttp)`.
### Managing Snapshots
**Example:** Prune an Old Snapshot
```typescript
const deleteSnapshot = yield* DocDBElastic.DeleteClusterSnapshot();

const result = yield* deleteSnapshot({ snapshotArn });
// result.snapshot.status → "DELETING"
```

@binding

## GetClusterSnapshot

Runtime binding for the `GetClusterSnapshot` operation (IAM action
`docdb-elastic:GetClusterSnapshot`).

Reads one elastic-cluster snapshot by ARN — status, source cluster, and
the network/encryption configuration captured at snapshot time. Snapshot
ARNs embed server-generated UUIDs and are runtime data, so the grant spans
the account's snapshots. Provide the implementation with
`Effect.provide(AWS.DocDBElastic.GetClusterSnapshotHttp)`.
### Managing Snapshots
**Example:** Poll a Snapshot Until Available
```typescript
const getSnapshot = yield* DocDBElastic.GetClusterSnapshot();

const result = yield* getSnapshot({ snapshotArn });
// result.snapshot.status → "AVAILABLE"
```

@binding

## GetPendingMaintenanceAction

Runtime binding for the `GetPendingMaintenanceAction` operation (IAM
action `docdb-elastic:GetPendingMaintenanceAction`).

Reads the pending maintenance actions for one resource (a cluster ARN) —
the action name, opt-in status, and apply dates. Provide the
implementation with
`Effect.provide(AWS.DocDBElastic.GetPendingMaintenanceActionHttp)`.
### Scheduling Maintenance
**Example:** Read a Cluster's Pending Maintenance
```typescript
const getPending = yield* DocDBElastic.GetPendingMaintenanceAction();

const result = yield* getPending({ resourceArn: cluster.clusterArn });
// result.resourcePendingMaintenanceAction.pendingMaintenanceActionDetails
```

@binding

## ListClusterSnapshots

Runtime binding for the `ListClusterSnapshots` operation (IAM action
`docdb-elastic:ListClusterSnapshots`).

Lists the account's elastic-cluster snapshots (one page per call —
`nextToken` continues), optionally filtered to one cluster's ARN or to
`manual`/`automated` snapshots. Provide the implementation with
`Effect.provide(AWS.DocDBElastic.ListClusterSnapshotsHttp)`.
### Managing Snapshots
**Example:** List a Cluster's Manual Snapshots
```typescript
const listSnapshots = yield* DocDBElastic.ListClusterSnapshots();

const page = yield* listSnapshots({
  clusterArn: cluster.clusterArn,
  snapshotType: "manual",
});
for (const snapshot of page.snapshots ?? []) {
  yield* Effect.logInfo(`${snapshot.snapshotName}: ${snapshot.status}`);
}
```

@binding

## ListPendingMaintenanceActions

Runtime binding for the `ListPendingMaintenanceActions` operation (IAM
action `docdb-elastic:ListPendingMaintenanceActions`).

Lists pending maintenance (e.g. engine updates) across every elastic
cluster in the account — feed it into an ops dashboard or a maintenance
scheduler. Provide the implementation with
`Effect.provide(AWS.DocDBElastic.ListPendingMaintenanceActionsHttp)`.
### Scheduling Maintenance
**Example:** List All Pending Maintenance
```typescript
const listPending = yield* DocDBElastic.ListPendingMaintenanceActions();

const page = yield* listPending();
for (const action of page.resourcePendingMaintenanceActions ?? []) {
  yield* Effect.logInfo(action.resourceArn ?? "");
}
```

@binding

## RestoreClusterFromSnapshot

Runtime binding for the `RestoreClusterFromSnapshot` operation (IAM
actions `docdb-elastic:RestoreClusterFromSnapshot` +
`docdb-elastic:TagResource`, plus the EC2 VPC-endpoint permissions elastic
clusters need to attach to a VPC).

Restores a new elastic cluster from a snapshot — e.g. a disaster-recovery
Lambda that rebuilds a cluster from the latest nightly backup. Provide the
implementation with
`Effect.provide(AWS.DocDBElastic.RestoreClusterFromSnapshotHttp)`.
### Managing Snapshots
**Example:** Restore a Cluster from a Snapshot
```typescript
const restoreCluster = yield* DocDBElastic.RestoreClusterFromSnapshot();

const result = yield* restoreCluster({
  snapshotArn,
  clusterName: "documents-restored",
});
// result.cluster.status → "CREATING"
```

@binding

## StartCluster

Runtime binding for the `StartCluster` operation (IAM action
`docdb-elastic:StartCluster`), scoped to one {@link Cluster}.

Restarts the bound elastic cluster after it was stopped — compute billing
resumes and the cluster transitions through `STARTING` back to `ACTIVE`.
Provide the implementation with
`Effect.provide(AWS.DocDBElastic.StartClusterHttp)`.
### Starting and Stopping a Cluster
**Example:** Start a Stopped Cluster
```typescript
const startCluster = yield* DocDBElastic.StartCluster(cluster);

const result = yield* startCluster();
// result.cluster.status → "STARTING"
```

@binding

## StopCluster

Runtime binding for the `StopCluster` operation (IAM action
`docdb-elastic:StopCluster`), scoped to one {@link Cluster}.

Stops the bound elastic cluster — compute billing pauses (storage is still
billed) and the cluster transitions through `STOPPING` to `STOPPED`. Use
from a scheduled Lambda to park non-production clusters outside working
hours. Provide the implementation with
`Effect.provide(AWS.DocDBElastic.StopClusterHttp)`.
### Starting and Stopping a Cluster
**Example:** Stop a Running Cluster
```typescript
const stopCluster = yield* DocDBElastic.StopCluster(cluster);

const result = yield* stopCluster();
// result.cluster.status → "STOPPING"
```

@binding
