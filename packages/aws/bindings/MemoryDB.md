<!-- Docs for the generated AWS.MemoryDB bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## BatchUpdateCluster

Runtime binding for the `BatchUpdateCluster` operation (IAM action
`memorydb:BatchUpdateCluster`).

Applies a service update (security patch, engine upgrade) to a list of
clusters — pair with {@link DescribeServiceUpdates} to build patch
automation that applies available updates inside a maintenance window.
Clusters that cannot take the update are returned in
`UnprocessedClusters` (with the reason) rather than failing the call.
Provide the implementation with
`Effect.provide(AWS.MemoryDB.BatchUpdateClusterHttp)`.
### Applying Service Updates
**Example:** Apply a Service Update to Clusters
```typescript
const batchUpdateCluster = yield* MemoryDB.BatchUpdateCluster();

const result = yield* batchUpdateCluster({
  ClusterNames: [clusterName],
  ServiceUpdate: { ServiceUpdateNameToApply: updateName },
});
// result.ProcessedClusters / result.UnprocessedClusters
```

@binding

## CopySnapshot

Runtime binding for the `CopySnapshot` operation (IAM actions
`memorydb:CopySnapshot` + `memorydb:TagResource` on the snapshot ARN
wildcard — snapshot names are runtime data).

Makes a copy of an existing snapshot, optionally exporting it to an S3
bucket via `TargetBucket`. Provide the implementation with
`Effect.provide(AWS.MemoryDB.CopySnapshotHttp)`.
### Managing Snapshots
**Example:** Copy a Snapshot
```typescript
const copySnapshot = yield* MemoryDB.CopySnapshot();

const result = yield* copySnapshot({
  SourceSnapshotName: "pre-migration",
  TargetSnapshotName: "pre-migration-archive",
});
// result.Snapshot.Status → "creating"
```

@binding

## CreateSnapshot

Runtime binding for the `CreateSnapshot` operation (IAM actions
`memorydb:CreateSnapshot` + `memorydb:TagResource`), scoped to one
{@link Cluster}.

Takes an on-demand snapshot of the bound cluster — e.g. a pre-migration
backup from an operational Lambda. Provide the implementation with
`Effect.provide(AWS.MemoryDB.CreateSnapshotHttp)`.
### Managing Snapshots
**Example:** Take an On-Demand Snapshot
```typescript
const createSnapshot = yield* MemoryDB.CreateSnapshot(cluster);

const result = yield* createSnapshot({ SnapshotName: "pre-migration" });
// result.Snapshot.Status → "creating"
```

@binding

## DeleteSnapshot

Runtime binding for the `DeleteSnapshot` operation (IAM action
`memorydb:DeleteSnapshot` on the snapshot ARN wildcard — snapshot names
are runtime data).

Deletes a snapshot by name — e.g. pruning old on-demand backups from a
scheduled cleanup Lambda. Provide the implementation with
`Effect.provide(AWS.MemoryDB.DeleteSnapshotHttp)`.
### Managing Snapshots
**Example:** Delete an Old Snapshot
```typescript
const deleteSnapshot = yield* MemoryDB.DeleteSnapshot();

yield* deleteSnapshot({ SnapshotName: "pre-migration" }).pipe(
  Effect.catchTag("SnapshotNotFoundFault", () => Effect.void),
);
```

@binding

## DescribeClusters

Runtime binding for the `DescribeClusters` operation (IAM action
`memorydb:DescribeClusters`).

Lists the account's MemoryDB clusters, or describes a single cluster by
name — e.g. checking a cluster's status or endpoint from an operational
Lambda. Provide the implementation with
`Effect.provide(AWS.MemoryDB.DescribeClustersHttp)`.
### Monitoring Clusters
**Example:** Check a Cluster's Status
```typescript
const describeClusters = yield* MemoryDB.DescribeClusters();

const page = yield* describeClusters({ ClusterName: clusterName });
// page.Clusters[0].Status → "available"
```

@binding

## DescribeEngineVersions

Runtime binding for the `DescribeEngineVersions` operation (IAM action
`memorydb:DescribeEngineVersions`).

Lists the engine versions MemoryDB supports (redis/valkey) and their
parameter group families — e.g. upgrade automation that checks whether a
newer engine version is available before scheduling a cluster update.
Provide the implementation with
`Effect.provide(AWS.MemoryDB.DescribeEngineVersionsHttp)`.
### Applying Service Updates
**Example:** List Supported Valkey Versions
```typescript
const describeEngineVersions = yield* MemoryDB.DescribeEngineVersions();

const page = yield* describeEngineVersions({ Engine: "valkey" });
// page.EngineVersions[0].EngineVersion
```

@binding

## DescribeEvents

Runtime binding for the `DescribeEvents` operation (IAM action
`memorydb:DescribeEvents`).

Returns events related to clusters, security groups, and parameter groups
from the last hour (up to 14 days with an explicit time window) — snapshot
completions, failovers, configuration changes. Provide the implementation
with `Effect.provide(AWS.MemoryDB.DescribeEventsHttp)`.
### Monitoring Clusters
**Example:** Read a Cluster's Recent Events
```typescript
const describeEvents = yield* MemoryDB.DescribeEvents();

const page = yield* describeEvents({
  SourceName: clusterName,
  SourceType: "cluster",
});
for (const event of page.Events ?? []) {
  yield* Effect.logInfo(`${event.Date}: ${event.Message}`);
}
```

@binding

## DescribeServiceUpdates

Runtime binding for the `DescribeServiceUpdates` operation (IAM action
`memorydb:DescribeServiceUpdates`).

Lists the service updates (security patches, engine upgrades) available or
scheduled for the account's clusters — pair with
{@link BatchUpdateCluster} to build patch automation. Provide the
implementation with
`Effect.provide(AWS.MemoryDB.DescribeServiceUpdatesHttp)`.
### Applying Service Updates
**Example:** List Available Service Updates
```typescript
const describeServiceUpdates = yield* MemoryDB.DescribeServiceUpdates();

const page = yield* describeServiceUpdates({ Status: ["available"] });
// page.ServiceUpdates[0].ServiceUpdateName
```

@binding

## DescribeSnapshots

Runtime binding for the `DescribeSnapshots` operation (IAM action
`memorydb:DescribeSnapshots`).

Lists the account's cluster snapshots, optionally filtered by cluster or
snapshot name — e.g. verifying a backup completed before a migration.
Provide the implementation with
`Effect.provide(AWS.MemoryDB.DescribeSnapshotsHttp)`.
### Managing Snapshots
**Example:** List a Cluster's Snapshots
```typescript
const describeSnapshots = yield* MemoryDB.DescribeSnapshots();

const page = yield* describeSnapshots({ ClusterName: clusterName });
for (const snapshot of page.Snapshots ?? []) {
  yield* Effect.logInfo(`${snapshot.Name}: ${snapshot.Status}`);
}
```

@binding

## FailoverShard

Runtime binding for the `FailoverShard` operation (IAM action
`memorydb:FailoverShard`), scoped to one {@link Cluster}.

Fails over a shard's primary node to a replica — designed for testing how
your application behaves during a MemoryDB failover (chaos testing), not
as a production remediation tool. Provide the implementation with
`Effect.provide(AWS.MemoryDB.FailoverShardHttp)`.
### Testing Failover
**Example:** Fail Over a Shard
```typescript
const failoverShard = yield* MemoryDB.FailoverShard(cluster);

const result = yield* failoverShard({ ShardName: "0001" });
// result.Cluster.Status → "updating"
```

@binding

## ListAllowedNodeTypeUpdates

Runtime binding for the `ListAllowedNodeTypeUpdates` operation (IAM action
`memorydb:ListAllowedNodeTypeUpdates`), scoped to one {@link Cluster}.

Lists the node types the bound cluster can scale up or down to — e.g.
right-sizing automation that checks the legal targets before calling
`UpdateCluster`. Provide the implementation with
`Effect.provide(AWS.MemoryDB.ListAllowedNodeTypeUpdatesHttp)`.
### Monitoring Clusters
**Example:** List the Cluster's Legal Node-Type Targets
```typescript
const listAllowedNodeTypeUpdates =
  yield* MemoryDB.ListAllowedNodeTypeUpdates(cluster);

const result = yield* listAllowedNodeTypeUpdates();
// result.ScaleUpNodeTypes / result.ScaleDownNodeTypes
```

@binding
