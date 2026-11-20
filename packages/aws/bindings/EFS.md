<!-- Docs for the generated AWS.EFS bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateAccessPoint

Runtime binding for the `CreateAccessPoint` operation (IAM actions
`elasticfilesystem:CreateAccessPoint` on the file system ARN and
`elasticfilesystem:TagResource` for tag-on-create).

Creates an access point into the bound {@link FileSystem} at runtime —
the multi-tenant pattern where each tenant gets its own POSIX identity
and root directory carved out of one file system. `ClientToken` makes the
create idempotent; a repeated identical create surfaces the typed
`AccessPointAlreadyExists`. For statically-known access points, prefer the
{@link AccessPoint} resource. Provide the implementation with
`Effect.provide(AWS.EFS.CreateAccessPointHttp)`.
### Managing Access Points at Runtime
**Example:** Create a per-tenant access point
```typescript
const createAccessPoint = yield* AWS.EFS.CreateAccessPoint(files);

const accessPoint = yield* createAccessPoint({
  ClientToken: `tenant-${tenantId}`,
  PosixUser: { Uid: 1000, Gid: 1000 },
  RootDirectory: {
    Path: `/tenants/${tenantId}`,
    CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: "750" },
  },
});
```

@binding

## CreateAccessPoint.Request

`CreateAccessPoint` request with `FileSystemId` injected from the bound
{@link FileSystem}.

## DeleteAccessPoint

Runtime binding for the `DeleteAccessPoint` operation (IAM action
`elasticfilesystem:DeleteAccessPoint`).

Deletes an access point by ID — the teardown half of the runtime
multi-tenant pattern built with {@link CreateAccessPoint}. The action
authorizes on the access point's own ARN, which for runtime-created
access points is unknowable at deploy time, so the grant is on `*`.
Deleting an already-deleted access point surfaces the typed
`AccessPointNotFound`. Provide the implementation with
`Effect.provide(AWS.EFS.DeleteAccessPointHttp)`.
### Managing Access Points at Runtime
**Example:** Delete a tenant's access point
```typescript
const deleteAccessPoint = yield* AWS.EFS.DeleteAccessPoint();

yield* deleteAccessPoint({ AccessPointId: accessPointId }).pipe(
  Effect.catchTag("AccessPointNotFound", () => Effect.void),
);
```

@binding

## DescribeAccessPoints

Runtime binding for the `DescribeAccessPoints` operation (IAM action
`elasticfilesystem:DescribeAccessPoints` on the file system ARN).

Lists the bound {@link FileSystem}'s access points — e.g. to enumerate the
per-tenant entry points created at runtime with
{@link CreateAccessPoint}. Provide the implementation with
`Effect.provide(AWS.EFS.DescribeAccessPointsHttp)`.
### Managing Access Points at Runtime
**Example:** List the file system's access points
```typescript
const describeAccessPoints = yield* AWS.EFS.DescribeAccessPoints(files);

const { AccessPoints } = yield* describeAccessPoints();
for (const accessPoint of AccessPoints ?? []) {
  yield* Effect.log(`${accessPoint.Name}: ${accessPoint.AccessPointId}`);
}
```

@binding

## DescribeAccessPoints.Request

`DescribeAccessPoints` request with `FileSystemId` injected from the bound
{@link FileSystem}.

## DescribeBackupPolicy

Runtime binding for the `DescribeBackupPolicy` operation (IAM action
`elasticfilesystem:DescribeBackupPolicy` on the file system ARN).

Reads whether AWS Backup automatic backups are enabled for the bound
{@link FileSystem}. A file system that has never had a backup policy
fails with the typed `PolicyNotFound`. Provide the implementation with
`Effect.provide(AWS.EFS.DescribeBackupPolicyHttp)`.
### Backup Policy
**Example:** Read the backup policy status
```typescript
const describeBackupPolicy = yield* AWS.EFS.DescribeBackupPolicy(files);

const status = yield* describeBackupPolicy().pipe(
  Effect.map((r) => r.BackupPolicy?.Status ?? "DISABLED"),
  Effect.catchTag("PolicyNotFound", () => Effect.succeed("DISABLED")),
);
```

@binding

## DescribeFileSystem

Runtime binding for the `DescribeFileSystems` operation scoped to one file
system (IAM action `elasticfilesystem:DescribeFileSystems` on the file
system ARN).

Reads the bound {@link FileSystem}'s live description — lifecycle state,
size in each storage class, throughput mode, mount target count — from
inside a function runtime. Useful for storage dashboards and capacity
monitors. Provide the implementation with
`Effect.provide(AWS.EFS.DescribeFileSystemHttp)`.
### Inspecting File Systems
**Example:** Read the file system's size and state
```typescript
// init — bind the operation to the file system
const describeFileSystem = yield* AWS.EFS.DescribeFileSystem(files);

// runtime
const response = yield* describeFileSystem();
const fs = response.FileSystems?.[0];
yield* Effect.log(`${fs?.LifeCycleState}: ${fs?.SizeInBytes?.Value} bytes`);
```

@binding

## DescribeLifecycleConfiguration

Runtime binding for the `DescribeLifecycleConfiguration` operation (IAM
action `elasticfilesystem:DescribeLifecycleConfiguration` on the file
system ARN).

Reads the bound {@link FileSystem}'s lifecycle management rules — when
files transition between Standard, Infrequent Access, and Archive storage.
A file system without lifecycle management returns an empty array.
Provide the implementation with
`Effect.provide(AWS.EFS.DescribeLifecycleConfigurationHttp)`.
### Lifecycle Management
**Example:** Read the lifecycle policies
```typescript
const describeLifecycleConfiguration =
  yield* AWS.EFS.DescribeLifecycleConfiguration(files);

const { LifecyclePolicies } = yield* describeLifecycleConfiguration();
```

@binding

## DescribeMountTargets

Runtime binding for the `DescribeMountTargets` operation (IAM action
`elasticfilesystem:DescribeMountTargets` on the file system ARN).

Lists the bound {@link FileSystem}'s mount targets — the per-AZ NFS
endpoints with their IP addresses and lifecycle states. Useful for health
checks and for compute that needs to discover a mount target's IP at
runtime. Provide the implementation with
`Effect.provide(AWS.EFS.DescribeMountTargetsHttp)`.
### Inspecting File Systems
**Example:** List the file system's mount targets
```typescript
const describeMountTargets = yield* AWS.EFS.DescribeMountTargets(files);

const { MountTargets } = yield* describeMountTargets();
for (const target of MountTargets ?? []) {
  yield* Effect.log(`${target.AvailabilityZoneName}: ${target.IpAddress}`);
}
```

@binding

## DescribeMountTargets.Request

`DescribeMountTargets` request with `FileSystemId` injected from the bound
{@link FileSystem}.

## DescribeReplicationConfigurations

Runtime binding for the `DescribeReplicationConfigurations` operation (IAM
action `elasticfilesystem:DescribeReplicationConfigurations` on the file
system ARN).

Reads the bound {@link FileSystem}'s replication configuration —
destination file systems, replication status, and last-replicated
timestamps. A file system with no replication fails with the typed
`ReplicationNotFound`. Provide the implementation with
`Effect.provide(AWS.EFS.DescribeReplicationConfigurationsHttp)`.
### Replication
**Example:** Check replication health
```typescript
const describeReplicationConfigurations =
  yield* AWS.EFS.DescribeReplicationConfigurations(files);

const status = yield* describeReplicationConfigurations().pipe(
  Effect.map((r) => r.Replications?.[0]?.Destinations[0]?.Status),
  Effect.catchTag("ReplicationNotFound", () => Effect.succeed(undefined)),
);
```

@binding

## DescribeReplicationConfigurations.Request

`DescribeReplicationConfigurations` request with `FileSystemId` injected
from the bound {@link FileSystem}.

## PutBackupPolicy

Runtime binding for the `PutBackupPolicy` operation (IAM action
`elasticfilesystem:PutBackupPolicy` on the file system ARN).

Starts or stops AWS Backup automatic backups for the bound
{@link FileSystem} at runtime. For declarative control, prefer the
FileSystem resource's `backup` prop — this binding is for operational
tooling that toggles backups on demand. Provide the implementation with
`Effect.provide(AWS.EFS.PutBackupPolicyHttp)`.
### Backup Policy
**Example:** Enable automatic backups
```typescript
const putBackupPolicy = yield* AWS.EFS.PutBackupPolicy(files);

const { BackupPolicy } = yield* putBackupPolicy({
  BackupPolicy: { Status: "ENABLED" },
});
```

@binding

## PutBackupPolicy.Request

`PutBackupPolicy` request with `FileSystemId` injected from the bound
{@link FileSystem}.

## PutLifecycleConfiguration

Runtime binding for the `PutLifecycleConfiguration` operation (IAM action
`elasticfilesystem:PutLifecycleConfiguration` on the file system ARN).

Replaces the bound {@link FileSystem}'s lifecycle management rules at
runtime; an empty `LifecyclePolicies` array disables lifecycle management.
For declarative control, prefer the FileSystem resource's
`lifecyclePolicies` prop — this binding is for operational tooling that
tunes storage tiering on demand. Provide the implementation with
`Effect.provide(AWS.EFS.PutLifecycleConfigurationHttp)`.
### Lifecycle Management
**Example:** Tier cold files to Infrequent Access
```typescript
const putLifecycleConfiguration =
  yield* AWS.EFS.PutLifecycleConfiguration(files);

yield* putLifecycleConfiguration({
  LifecyclePolicies: [{ TransitionToIA: "AFTER_30_DAYS" }],
});
```

@binding

## PutLifecycleConfiguration.Request

`PutLifecycleConfiguration` request with `FileSystemId` injected from the
bound {@link FileSystem}.
