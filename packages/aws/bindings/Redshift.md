<!-- Docs for the generated AWS.Redshift bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CopyClusterSnapshot

Runtime binding for the `CopyClusterSnapshot` operation (IAM action
`redshift:CopyClusterSnapshot`).

Copies an automated cluster snapshot to a manual one so it survives the
automated retention window — e.g. an archival job that preserves the
nightly snapshot before a risky migration. Provide the implementation with
`Effect.provide(AWS.Redshift.CopyClusterSnapshotHttp)`.
### Managing Snapshots
**Example:** Preserve an Automated Snapshot
```typescript
const copyClusterSnapshot = yield* AWS.Redshift.CopyClusterSnapshot();

yield* copyClusterSnapshot({
  SourceSnapshotIdentifier: nightly.SnapshotIdentifier!,
  TargetSnapshotIdentifier: `archive-${runId}`,
});
```

@binding

## CreateClusterSnapshot

Runtime binding for the `CreateClusterSnapshot` operation (IAM action
`redshift:CreateClusterSnapshot` on the cluster and its
`snapshot:{cluster}/*` ARNs).

Takes a manual snapshot of the bound {@link Cluster} — e.g. a
pre-migration backup function or a scheduled snapshot-rotation job. The
cluster identifier is injected from the binding. Provide the
implementation with
`Effect.provide(AWS.Redshift.CreateClusterSnapshotHttp)`.
### Managing Snapshots
**Example:** Take a Manual Snapshot
```typescript
// init — bind the operation to the cluster
const createClusterSnapshot =
  yield* AWS.Redshift.CreateClusterSnapshot(cluster);

// runtime
yield* createClusterSnapshot({
  SnapshotIdentifier: `pre-migration-${runId}`,
});
```

@binding

## DeleteClusterSnapshot

Runtime binding for the `DeleteClusterSnapshot` operation (IAM action
`redshift:DeleteClusterSnapshot`).

Deletes a manual cluster snapshot by identifier — the cleanup half of a
snapshot-rotation job (automated snapshots cannot be deleted; they expire
with the retention period). Provide the implementation with
`Effect.provide(AWS.Redshift.DeleteClusterSnapshotHttp)`.
### Managing Snapshots
**Example:** Delete an Expired Manual Snapshot
```typescript
const deleteClusterSnapshot = yield* AWS.Redshift.DeleteClusterSnapshot();

yield* deleteClusterSnapshot({
  SnapshotIdentifier: expired.SnapshotIdentifier!,
});
```

@binding

## DescribeClusterSnapshots

Runtime binding for the `DescribeClusterSnapshots` operation (IAM action
`redshift:DescribeClusterSnapshots`).

Lists the account's cluster snapshots (manual and automated) — e.g. a
snapshot-rotation job that finds manual snapshots older than the retention
window before deleting them. Provide the implementation with
`Effect.provide(AWS.Redshift.DescribeClusterSnapshotsHttp)`.
### Managing Snapshots
**Example:** List a Cluster's Manual Snapshots
```typescript
const describeClusterSnapshots =
  yield* AWS.Redshift.DescribeClusterSnapshots();

const page = yield* describeClusterSnapshots({
  ClusterIdentifier: clusterId,
  SnapshotType: "manual",
});
const identifiers = page.Snapshots?.map((s) => s.SnapshotIdentifier);
```

@binding

## DescribeClusters

Runtime binding for the `DescribeClusters` operation (IAM action
`redshift:DescribeClusters`).

Lists the account's provisioned Redshift clusters or looks one up by
identifier — e.g. an ops function that checks whether the warehouse is
`available` before submitting a load. Provide the implementation with
`Effect.provide(AWS.Redshift.DescribeClustersHttp)`.
### Monitoring Clusters
**Example:** Check a Cluster's Status
```typescript
const describeClusters = yield* AWS.Redshift.DescribeClusters();

const page = yield* describeClusters({ ClusterIdentifier: clusterId });
const status = page.Clusters?.[0]?.ClusterStatus;
```

@binding

## DescribeEvents

Runtime binding for the `DescribeEvents` operation (IAM action
`redshift:DescribeEvents`).

Lists recent events (maintenance, resizes, snapshots, security changes)
for the account's Redshift clusters and related resources over the last 14
days — the audit trail for operational tooling. For push delivery of the
same events see {@link EventSubscription}. Provide the implementation with
`Effect.provide(AWS.Redshift.DescribeEventsHttp)`.
### Monitoring Clusters
**Example:** List a Cluster's Recent Events
```typescript
const describeEvents = yield* AWS.Redshift.DescribeEvents();

const page = yield* describeEvents({
  SourceIdentifier: clusterId,
  SourceType: "cluster",
});
const messages = page.Events?.map((e) => e.Message);
```

@binding

## PauseCluster

Runtime binding for the `PauseCluster` operation (IAM action
`redshift:PauseCluster`).

Pauses the bound {@link Cluster} (compute billing stops, storage
persists) — e.g. a scheduled ops function that parks the warehouse
overnight to save cost. The cluster identifier is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.Redshift.PauseClusterHttp)`.
### Operating a Cluster
**Example:** Pause the Warehouse Overnight
```typescript
// init — bind the operation to the cluster
const pauseCluster = yield* AWS.Redshift.PauseCluster(cluster);

// runtime
yield* pauseCluster();
```

@binding

## RebootCluster

Runtime binding for the `RebootCluster` operation (IAM action
`redshift:RebootCluster`).

Reboots the bound {@link Cluster} (a momentary outage while it restarts) —
e.g. an ops function that applies pending static parameter-group changes.
The cluster identifier is injected from the binding. Provide the
implementation with `Effect.provide(AWS.Redshift.RebootClusterHttp)`.
### Operating a Cluster
**Example:** Reboot to Apply Static Parameters
```typescript
// init — bind the operation to the cluster
const rebootCluster = yield* AWS.Redshift.RebootCluster(cluster);

// runtime
yield* rebootCluster();
```

@binding

## ResumeCluster

Runtime binding for the `ResumeCluster` operation (IAM action
`redshift:ResumeCluster`).

Resumes the bound paused {@link Cluster} — the morning half of an
overnight pause schedule. The cluster identifier is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.Redshift.ResumeClusterHttp)`.
### Operating a Cluster
**Example:** Resume the Warehouse in the Morning
```typescript
// init — bind the operation to the cluster
const resumeCluster = yield* AWS.Redshift.ResumeCluster(cluster);

// runtime
yield* resumeCluster();
```

@binding
