<!-- Docs for the generated AWS.FSx bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CancelDataRepositoryTask

Runtime binding for the `CancelDataRepositoryTask` operation (IAM action
`fsx:CancelDataRepositoryTask` on `*` — runtime-created tasks have ARNs
unknowable at deploy time).

Cancels a `PENDING` or `EXECUTING` Lustre data repository task started
with {@link CreateDataRepositoryTask}. A task that already finished
surfaces the typed `DataRepositoryTaskEnded`. Provide the implementation
with `Effect.provide(AWS.FSx.CancelDataRepositoryTaskHttp)`.
### Data Repository Tasks
**Example:** Cancel a runaway export
```typescript
const cancelDataRepositoryTask =
  yield* AWS.FSx.CancelDataRepositoryTask();

yield* cancelDataRepositoryTask({ TaskId: taskId }).pipe(
  Effect.catchTag("DataRepositoryTaskEnded", () => Effect.void),
);
```

@binding

## CopyBackup

Runtime binding for the `CopyBackup` operation (IAM actions
`fsx:CopyBackup` + `fsx:TagResource` on `*` — both the source and the new
backup's ARNs are unknowable at deploy time).

Copies an FSx backup within a region or from another region — the
cross-region disaster-recovery half of a runtime backup rotation built
with {@link CreateBackup}. A missing source backup surfaces the typed
`BackupNotFound`. Provide the implementation with
`Effect.provide(AWS.FSx.CopyBackupHttp)`.
### Managing Backups at Runtime
**Example:** Copy a backup from another region for DR
```typescript
const copyBackup = yield* AWS.FSx.CopyBackup();

const copy = yield* copyBackup({
  SourceBackupId: backup.BackupId!,
  SourceRegion: "us-east-1",
});
```

@binding

## CopySnapshotAndUpdateVolume

Runtime binding for the `CopySnapshotAndUpdateVolume` operation (IAM
action `fsx:CopySnapshotAndUpdateVolume` on `*`).

Updates an existing FSx for OpenZFS volume from a snapshot on another FSx
for OpenZFS file system (on-demand data replication) — the cross-file-system
counterpart of {@link RestoreVolumeFromSnapshot}. Provide the
implementation with `Effect.provide(AWS.FSx.CopySnapshotAndUpdateVolumeHttp)`.
### Managing Snapshots at Runtime
**Example:** Replicate a snapshot from another file system into a volume
```typescript
const copySnapshotAndUpdateVolume =
  yield* AWS.FSx.CopySnapshotAndUpdateVolume();

const response = yield* copySnapshotAndUpdateVolume({
  VolumeId: volumeId,
  SourceSnapshotARN: sourceSnapshot.ResourceARN!,
  CopyStrategy: "INCREMENTAL_COPY",
});
yield* Effect.log(`volume ${response.VolumeId} updating`);
```

@binding

## CreateBackup

Runtime binding for the `CreateBackup` operation scoped to one file system
(IAM actions `fsx:CreateBackup` and `fsx:TagResource` on the file system
ARN and on `arn:aws:fsx:*:*:backup/*` — the new backup's ARN is unknowable
at deploy time).

Takes a user-initiated backup of the bound {@link FileSystem} — e.g.
before a risky data migration, or on an application-defined cadence
richer than the daily automatic backup. Pass a `ClientRequestToken` to
make the call idempotent. A backup already in progress surfaces the typed
`BackupInProgress`. Provide the implementation with
`Effect.provide(AWS.FSx.CreateBackupHttp)`.
### Managing Backups at Runtime
**Example:** Take a pre-migration backup
```typescript
const createBackup = yield* AWS.FSx.CreateBackup(files);

const response = yield* createBackup({
  ClientRequestToken: `migration-${migrationId}`,
  Tags: [{ Key: "reason", Value: "pre-migration" }],
});
yield* Effect.log(`backup ${response.Backup?.BackupId} started`);
```

@binding

## CreateDataRepositoryTask

Runtime binding for the `CreateDataRepositoryTask` operation scoped to one
Lustre file system (IAM actions `fsx:CreateDataRepositoryTask` and
`fsx:TagResource` on the file system ARN and on `arn:aws:fsx:*:*:task/*`).

Starts a bulk data movement between the bound Lustre {@link FileSystem}
and its linked S3 data repository — `EXPORT_TO_REPOSITORY`,
`IMPORT_METADATA_FROM_REPOSITORY`, or `RELEASE_DATA_FROM_FILESYSTEM` —
from inside a function runtime, e.g. exporting results after a compute
job completes. A task already executing surfaces the typed
`DataRepositoryTaskExecuting`. Provide the implementation with
`Effect.provide(AWS.FSx.CreateDataRepositoryTaskHttp)`.
### Data Repository Tasks
**Example:** Export results to the linked S3 repository
```typescript
const createDataRepositoryTask =
  yield* AWS.FSx.CreateDataRepositoryTask(scratch);

const response = yield* createDataRepositoryTask({
  Type: "EXPORT_TO_REPOSITORY",
  Paths: ["results/"],
  Report: { Enabled: false },
});
yield* Effect.log(`task ${response.DataRepositoryTask?.TaskId} started`);
```

@binding

## CreateSnapshot

Runtime binding for the `CreateSnapshot` operation (IAM actions
`fsx:CreateSnapshot` and `fsx:TagResource` on `*` — snapshots target
OpenZFS volumes whose ARNs are typically runtime values).

Takes a point-in-time snapshot of an FSx for OpenZFS volume — e.g.
before applying a batch of writes so they can be rolled back with
{@link RestoreVolumeFromSnapshot}. Pass a `ClientRequestToken` to make
the call idempotent. Provide the implementation with
`Effect.provide(AWS.FSx.CreateSnapshotHttp)`.
### Managing Snapshots at Runtime
**Example:** Snapshot a volume before a risky write
```typescript
const createSnapshot = yield* AWS.FSx.CreateSnapshot();

const response = yield* createSnapshot({
  Name: "pre-batch-42",
  VolumeId: volumeId,
});
yield* Effect.log(`snapshot ${response.Snapshot?.SnapshotId} started`);
```

@binding

## DeleteBackup

Runtime binding for the `DeleteBackup` operation (IAM action
`fsx:DeleteBackup` on `*` — runtime-created backups have ARNs unknowable
at deploy time).

Deletes an FSx backup by id — the teardown half of a runtime backup
rotation built with {@link CreateBackup}. Deleting an already-deleted
backup surfaces the typed `BackupNotFound`. Provide the implementation
with `Effect.provide(AWS.FSx.DeleteBackupHttp)`.
### Managing Backups at Runtime
**Example:** Rotate out an expired backup
```typescript
const deleteBackup = yield* AWS.FSx.DeleteBackup();

yield* deleteBackup({ BackupId: expired.BackupId! }).pipe(
  Effect.catchTag("BackupNotFound", () => Effect.void),
);
```

@binding

## DeleteSnapshot

Runtime binding for the `DeleteSnapshot` operation (IAM action
`fsx:DeleteSnapshot` on `*` — runtime-created snapshots have ARNs
unknowable at deploy time).

Deletes an FSx for OpenZFS snapshot by id — the teardown half of a
runtime snapshot rotation built with {@link CreateSnapshot}. Deleting an
already-deleted snapshot surfaces the typed `SnapshotNotFound`. Provide
the implementation with `Effect.provide(AWS.FSx.DeleteSnapshotHttp)`.
### Managing Snapshots at Runtime
**Example:** Rotate out an old snapshot
```typescript
const deleteSnapshot = yield* AWS.FSx.DeleteSnapshot();

yield* deleteSnapshot({ SnapshotId: old.SnapshotId! }).pipe(
  Effect.catchTag("SnapshotNotFound", () => Effect.void),
);
```

@binding

## DescribeBackups

Runtime binding for the `DescribeBackups` operation (IAM action
`fsx:DescribeBackups` on `*`).

Lists FSx backups — optionally filtered by `file-system-id`,
`backup-type`, or explicit `BackupIds` — from inside a function runtime.
Pairs with {@link CreateBackup} to poll a runtime-initiated backup until
it reaches `AVAILABLE`. Provide the implementation with
`Effect.provide(AWS.FSx.DescribeBackupsHttp)`.
### Managing Backups at Runtime
**Example:** List a file system's backups
```typescript
const describeBackups = yield* AWS.FSx.DescribeBackups();

const response = yield* describeBackups({
  Filters: [{ Name: "file-system-id", Values: [fileSystemId] }],
});
yield* Effect.log(`${response.Backups?.length ?? 0} backups`);
```

@binding

## DescribeDataRepositoryAssociations

Runtime binding for the `DescribeDataRepositoryAssociations` operation
(IAM action `fsx:DescribeDataRepositoryAssociations` on `*`).

Lists the S3 data repository associations linked to Lustre file systems —
optionally filtered by `file-system-id` — from inside a function runtime,
e.g. to discover the S3 prefix a {@link CreateDataRepositoryTask} export
will land in. Provide the implementation with
`Effect.provide(AWS.FSx.DescribeDataRepositoryAssociationsHttp)`.
### Data Repository Tasks
**Example:** List a file system's data repository associations
```typescript
const describeDataRepositoryAssociations =
  yield* AWS.FSx.DescribeDataRepositoryAssociations();

const response = yield* describeDataRepositoryAssociations({
  Filters: [{ Name: "file-system-id", Values: [fileSystemId] }],
});
yield* Effect.log(response.Associations?.[0]?.DataRepositoryPath);
```

@binding

## DescribeDataRepositoryTasks

Runtime binding for the `DescribeDataRepositoryTasks` operation (IAM
action `fsx:DescribeDataRepositoryTasks` on `*`).

Lists Lustre data repository tasks — optionally filtered by
`file-system-id` or `task-lifecycle`, or by explicit `TaskIds` — from
inside a function runtime. Pairs with {@link CreateDataRepositoryTask} to
poll an export/import task until it reaches `SUCCEEDED`. Provide the
implementation with
`Effect.provide(AWS.FSx.DescribeDataRepositoryTasksHttp)`.
### Data Repository Tasks
**Example:** Poll a task until it finishes
```typescript
const describeDataRepositoryTasks =
  yield* AWS.FSx.DescribeDataRepositoryTasks();

const response = yield* describeDataRepositoryTasks({
  TaskIds: [taskId],
});
yield* Effect.log(response.DataRepositoryTasks?.[0]?.Lifecycle);
```

@binding

## DescribeFileSystem

Runtime binding for the `DescribeFileSystems` operation scoped to one file
system (IAM action `fsx:DescribeFileSystems` on the file system ARN).

Reads the bound {@link FileSystem}'s live description — lifecycle state,
storage capacity, DNS name, engine configuration — from inside a function
runtime. Useful for storage dashboards and capacity monitors. Provide the
implementation with `Effect.provide(AWS.FSx.DescribeFileSystemHttp)`.
### Inspecting File Systems
**Example:** Read the file system's state and capacity
```typescript
// init — bind the operation to the file system
const describeFileSystem = yield* AWS.FSx.DescribeFileSystem(files);

// runtime
const response = yield* describeFileSystem();
const fs = response.FileSystems?.[0];
yield* Effect.log(`${fs?.Lifecycle}: ${fs?.StorageCapacity} GiB`);
```

@binding

## DescribeSnapshots

Runtime binding for the `DescribeSnapshots` operation (IAM action
`fsx:DescribeSnapshots` on `*`).

Lists FSx for OpenZFS snapshots — optionally filtered by `volume-id` or
`file-system-id` — from inside a function runtime. Pairs with
{@link CreateSnapshot} to poll a runtime-initiated snapshot until it
reaches `AVAILABLE`. Provide the implementation with
`Effect.provide(AWS.FSx.DescribeSnapshotsHttp)`.
### Managing Snapshots at Runtime
**Example:** List a volume's snapshots
```typescript
const describeSnapshots = yield* AWS.FSx.DescribeSnapshots();

const response = yield* describeSnapshots({
  Filters: [{ Name: "volume-id", Values: [volumeId] }],
});
yield* Effect.log(`${response.Snapshots?.length ?? 0} snapshots`);
```

@binding

## DescribeStorageVirtualMachines

Runtime binding for the `DescribeStorageVirtualMachines` operation (IAM
action `fsx:DescribeStorageVirtualMachines` on `*`).

Lists FSx for ONTAP storage virtual machines (SVMs) — optionally filtered
by `file-system-id` — from inside a function runtime, e.g. to resolve an
SVM's endpoints before opening an iSCSI/NFS session. Provide the
implementation with
`Effect.provide(AWS.FSx.DescribeStorageVirtualMachinesHttp)`.
### Inspecting File Systems
**Example:** List a file system's SVMs
```typescript
const describeStorageVirtualMachines =
  yield* AWS.FSx.DescribeStorageVirtualMachines();

const response = yield* describeStorageVirtualMachines({
  Filters: [{ Name: "file-system-id", Values: [fileSystemId] }],
});
yield* Effect.log(
  `${response.StorageVirtualMachines?.length ?? 0} SVMs`,
);
```

@binding

## DescribeVolumes

Runtime binding for the `DescribeVolumes` operation (IAM action
`fsx:DescribeVolumes` on `*`).

Lists FSx for ONTAP / OpenZFS volumes — optionally filtered by
`file-system-id` or `storage-virtual-machine-id` — from inside a function
runtime. Useful for discovering the volume ids that the snapshot bindings
operate on. Provide the implementation with
`Effect.provide(AWS.FSx.DescribeVolumesHttp)`.
### Inspecting File Systems
**Example:** List a file system's volumes
```typescript
const describeVolumes = yield* AWS.FSx.DescribeVolumes();

const response = yield* describeVolumes({
  Filters: [{ Name: "file-system-id", Values: [fileSystemId] }],
});
yield* Effect.log(`${response.Volumes?.length ?? 0} volumes`);
```

@binding

## ReleaseFileSystemNfsV3Locks

Runtime binding for the `ReleaseFileSystemNfsV3Locks` operation scoped to
one OpenZFS file system (IAM action `fsx:ReleaseFileSystemNfsV3Locks` on
the file system ARN).

Releases all NFSv3 byte-range locks held on the bound OpenZFS
{@link FileSystem} — the recovery action for clients that crashed while
holding locks and left files stuck. Provide the implementation with
`Effect.provide(AWS.FSx.ReleaseFileSystemNfsV3LocksHttp)`.
### Operational Recovery
**Example:** Release stuck NFSv3 locks
```typescript
const releaseLocks = yield* AWS.FSx.ReleaseFileSystemNfsV3Locks(zfs);

const response = yield* releaseLocks();
yield* Effect.log(`file system ${response.FileSystem?.FileSystemId} locks released`);
```

@binding

## RestoreVolumeFromSnapshot

Runtime binding for the `RestoreVolumeFromSnapshot` operation (IAM action
`fsx:RestoreVolumeFromSnapshot` on `*`).

Rolls an FSx for OpenZFS volume back to the state saved by a snapshot —
the undo half of the runtime snapshot pattern built with
{@link CreateSnapshot}. Pass `Options: ["DELETE_INTERMEDIATE_SNAPSHOTS"]`
to roll back past newer snapshots. Provide the implementation with
`Effect.provide(AWS.FSx.RestoreVolumeFromSnapshotHttp)`.
### Managing Snapshots at Runtime
**Example:** Roll back a failed batch of writes
```typescript
const restoreVolumeFromSnapshot =
  yield* AWS.FSx.RestoreVolumeFromSnapshot();

const response = yield* restoreVolumeFromSnapshot({
  VolumeId: volumeId,
  SnapshotId: snapshot.SnapshotId!,
});
yield* Effect.log(`volume ${response.VolumeId} restoring`);
```

@binding

## UpdateSnapshot

Runtime binding for the `UpdateSnapshot` operation (IAM action
`fsx:UpdateSnapshot` on `*` — runtime-created snapshots have ARNs
unknowable at deploy time).

Renames an OpenZFS volume snapshot — the management half of a runtime
snapshot rotation built with {@link CreateSnapshot}. A missing snapshot
surfaces the typed `UpdateSnapshotNotFound` (FSx reports it as a wire
`BadRequest`; the distilled patch carves out the typed tag by message).
Provide the implementation with
`Effect.provide(AWS.FSx.UpdateSnapshotHttp)`.
### Managing Snapshots at Runtime
**Example:** Rename a snapshot after promotion
```typescript
const updateSnapshot = yield* AWS.FSx.UpdateSnapshot();

yield* updateSnapshot({
  SnapshotId: snapshot.SnapshotId!,
  Name: "nightly-promoted",
});
```

@binding
