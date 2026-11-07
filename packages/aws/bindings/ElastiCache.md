<!-- Docs for the generated AWS.ElastiCache bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CopyServerlessCacheSnapshot

Runtime binding for the `CopyServerlessCacheSnapshot` operation (IAM
actions `elasticache:CopyServerlessCacheSnapshot` +
`elasticache:AddTagsToResource`).

Copies an existing serverless cache snapshot, optionally re-encrypting it
under a different KMS key — e.g. duplicating a nightly backup before a
risky migration. Available for valkey, redis, and serverless memcached.
Provide the implementation with
`Effect.provide(AWS.ElastiCache.CopyServerlessCacheSnapshotHttp)`.
### Managing Snapshots
**Example:** Copy a Snapshot
```typescript
const copySnapshot = yield* ElastiCache.CopyServerlessCacheSnapshot();

const result = yield* copySnapshot({
  SourceServerlessCacheSnapshotName: "nightly",
  TargetServerlessCacheSnapshotName: "pre-migration",
});
```

@binding

## CreateServerlessCacheSnapshot

Runtime binding for the `CreateServerlessCacheSnapshot` operation (IAM
actions `elasticache:CreateServerlessCacheSnapshot` +
`elasticache:AddTagsToResource`), scoped to one {@link ServerlessCache}.

Takes an on-demand snapshot of the bound serverless cache — e.g. a
pre-migration backup from an operational Lambda. Available for valkey,
redis, and serverless memcached. Provide the implementation with
`Effect.provide(AWS.ElastiCache.CreateServerlessCacheSnapshotHttp)`.
### Managing Snapshots
**Example:** Take an On-Demand Snapshot
```typescript
const createSnapshot = yield* ElastiCache.CreateServerlessCacheSnapshot(cache);

const result = yield* createSnapshot({
  ServerlessCacheSnapshotName: "pre-migration",
});
// result.ServerlessCacheSnapshot.Status → "creating"
```

@binding

## DeleteServerlessCacheSnapshot

Runtime binding for the `DeleteServerlessCacheSnapshot` operation (IAM
action `elasticache:DeleteServerlessCacheSnapshot`).

Deletes a serverless cache snapshot by name — e.g. rotating out old manual
backups from a maintenance Lambda. Available for valkey, redis, and
serverless memcached. Provide the implementation with
`Effect.provide(AWS.ElastiCache.DeleteServerlessCacheSnapshotHttp)`.
### Managing Snapshots
**Example:** Delete an Old Snapshot
```typescript
const deleteSnapshot = yield* ElastiCache.DeleteServerlessCacheSnapshot();

yield* deleteSnapshot({ ServerlessCacheSnapshotName: "pre-migration" }).pipe(
  Effect.catchTag("ServerlessCacheSnapshotNotFoundFault", () => Effect.void),
);
```

@binding

## DescribeEvents

Runtime binding for the `DescribeEvents` operation (IAM action
`elasticache:DescribeEvents`).

Returns events related to caches, replication groups, security groups, and
parameter groups from the last hour (up to 14 days with an explicit time
window) — snapshot completions, failovers, configuration changes. Provide
the implementation with `Effect.provide(AWS.ElastiCache.DescribeEventsHttp)`.
### Monitoring Caches
**Example:** Read a Cache's Recent Events
```typescript
const describeEvents = yield* ElastiCache.DescribeEvents();

const page = yield* describeEvents({
  SourceIdentifier: cacheName,
  SourceType: "serverless-cache",
});
for (const event of page.Events ?? []) {
  yield* Effect.logInfo(`${event.Date}: ${event.Message}`);
}
```

@binding

## DescribeServerlessCacheSnapshots

Runtime binding for the `DescribeServerlessCacheSnapshots` operation (IAM
action `elasticache:DescribeServerlessCacheSnapshots`).

Lists serverless cache snapshots — all of them, one by name, or those of a
particular cache. Available for valkey, redis, and serverless memcached.
Provide the implementation with
`Effect.provide(AWS.ElastiCache.DescribeServerlessCacheSnapshotsHttp)`.
### Managing Snapshots
**Example:** List a Cache's Snapshots
```typescript
const describeSnapshots = yield* ElastiCache.DescribeServerlessCacheSnapshots();

const result = yield* describeSnapshots({ ServerlessCacheName: name });
for (const snapshot of result.ServerlessCacheSnapshots ?? []) {
  yield* Effect.logInfo(`${snapshot.ServerlessCacheSnapshotName}: ${snapshot.Status}`);
}
```

@binding

## DescribeServerlessCaches

Runtime binding for the `DescribeServerlessCaches` operation (IAM action
`elasticache:DescribeServerlessCaches`).

Reads the current status, endpoint, and configuration of the account's
serverless caches — e.g. an operational health check that verifies a cache
is `available` before routing traffic. Provide the implementation with
`Effect.provide(AWS.ElastiCache.DescribeServerlessCachesHttp)`.
### Monitoring Caches
**Example:** Check a Cache's Status
```typescript
const describeCaches = yield* ElastiCache.DescribeServerlessCaches();

const result = yield* describeCaches({ ServerlessCacheName: name });
// result.ServerlessCaches?.[0]?.Status → "available"
```

@binding

## ExportServerlessCacheSnapshot

Runtime binding for the `ExportServerlessCacheSnapshot` operation (IAM
action `elasticache:ExportServerlessCacheSnapshot`).

Exports a serverless cache snapshot's data to an S3 bucket — e.g. shipping
a backup out of ElastiCache for offline analysis or cross-account
restore. Available for valkey and redis only. The target bucket must grant
the ElastiCache service access via its bucket policy. Provide the
implementation with
`Effect.provide(AWS.ElastiCache.ExportServerlessCacheSnapshotHttp)`.
### Managing Snapshots
**Example:** Export a Snapshot to S3
```typescript
const exportSnapshot = yield* ElastiCache.ExportServerlessCacheSnapshot();

yield* exportSnapshot({
  ServerlessCacheSnapshotName: "nightly",
  S3BucketName: "my-backup-bucket",
});
```

@binding
