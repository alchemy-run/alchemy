<!-- Docs for the generated AWS.DirectoryService bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CreateComputer

Runtime binding for the `CreateComputer` operation (IAM action
`ds:CreateComputer`), scoped to one {@link Directory}.

Creates a computer account in the bound directory — the programmatic half
of joining a machine to the domain (e.g. from an instance-provisioning
workflow). `Password` is the one-time machine password and is sensitive;
pass a `Redacted` value. The directory id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DirectoryService.CreateComputerHttp)`.
### Managing Computers
**Example:** Create a Computer Account
```typescript
// init — bind the operation to the directory
const createComputer = yield* AWS.DirectoryService.CreateComputer(directory);

// runtime
const { Computer } = yield* createComputer({
  ComputerName: "BUILD-AGENT-01",
  Password: Redacted.make("0ne-Time-Secret!"),
});
```

@binding

## CreateSnapshot

Runtime binding for the `CreateSnapshot` operation (IAM action
`ds:CreateSnapshot`), scoped to one {@link Directory}.

Takes a manual snapshot of the bound Simple AD or Managed Microsoft AD
directory — e.g. before a scheduled change — returning the new
`SnapshotId`. Manual snapshots are limited per directory (see
{@link GetSnapshotLimits}). The directory id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DirectoryService.CreateSnapshotHttp)`.
### Managing Snapshots
**Example:** Snapshot the Directory Before a Change
```typescript
// init — bind the operation to the directory
const createSnapshot = yield* AWS.DirectoryService.CreateSnapshot(directory);

// runtime
const { SnapshotId } = yield* createSnapshot({ Name: "pre-migration" });
```

@binding

## DescribeDirectories

Runtime binding for the `DescribeDirectories` operation (IAM action
`ds:DescribeDirectories`).

Reads directory descriptions at runtime — stage, DNS addresses, VPC
settings — for some or all of the account's directories. The action does
not support resource-level permissions, so the grant is account-wide.
Provide the implementation with
`Effect.provide(AWS.DirectoryService.DescribeDirectoriesHttp)`.
### Reading Directories
**Example:** Read a Directory's Stage and DNS Servers
```typescript
// init — request the account-level capability
const describeDirectories = yield* AWS.DirectoryService.DescribeDirectories();

// runtime
const { DirectoryDescriptions } = yield* describeDirectories({
  DirectoryIds: [directoryId],
});
const directory = DirectoryDescriptions?.[0];
console.log(directory?.Stage, directory?.DnsIpAddrs);
```

@binding

## DescribeDomainControllers

Runtime binding for the `DescribeDomainControllers` operation (IAM action
`ds:DescribeDomainControllers`), scoped to one {@link Directory}.

Lists the bound directory's domain controllers — id, DNS address,
Availability Zone, and status (`Active`, `Impaired`, …) — so a monitoring
function can alert on an impaired controller. The directory id is
injected from the binding. Provide the implementation with
`Effect.provide(AWS.DirectoryService.DescribeDomainControllersHttp)`.
### Monitoring the Directory
**Example:** Alert on Impaired Domain Controllers
```typescript
// init — bind the operation to the directory
const describeDomainControllers =
  yield* AWS.DirectoryService.DescribeDomainControllers(directory);

// runtime
const { DomainControllers } = yield* describeDomainControllers();
for (const controller of DomainControllers ?? []) {
  if (controller.Status === "Impaired") {
    yield* Effect.logError(`impaired controller: ${controller.DomainControllerId}`);
  }
}
```

@binding

## DescribeSnapshots

Runtime binding for the `DescribeSnapshots` operation (IAM action
`ds:DescribeSnapshots`), scoped to one {@link Directory}.

Lists the bound directory's snapshots — id, type (`Auto`/`Manual`),
status, and start time. The directory id is injected from the binding.
Provide the implementation with
`Effect.provide(AWS.DirectoryService.DescribeSnapshotsHttp)`.
### Managing Snapshots
**Example:** List the Directory's Snapshots
```typescript
// init — bind the operation to the directory
const describeSnapshots = yield* AWS.DirectoryService.DescribeSnapshots(directory);

// runtime
const { Snapshots } = yield* describeSnapshots();
for (const snapshot of Snapshots ?? []) {
  console.log(snapshot.SnapshotId, snapshot.Status);
}
```

@binding

## GetDirectoryLimits

Runtime binding for the `GetDirectoryLimits` operation (IAM action
`ds:GetDirectoryLimits`).

Reads the account's directory limits for the current region — how many
cloud directories exist versus the allowed maximum — so an ops function
can alert before directory creation starts failing. The action does not
support resource-level permissions, so the grant is account-wide. Provide
the implementation with
`Effect.provide(AWS.DirectoryService.GetDirectoryLimitsHttp)`.
### Reading Account Limits
**Example:** Alert When the Directory Limit Is Near
```typescript
// init — request the account-level capability
const getDirectoryLimits = yield* AWS.DirectoryService.GetDirectoryLimits();

// runtime
const { DirectoryLimits } = yield* getDirectoryLimits();
if (DirectoryLimits?.CloudOnlyDirectoriesLimitReached) {
  yield* Effect.logWarning("directory limit reached");
}
```

@binding

## GetSnapshotLimits

Runtime binding for the `GetSnapshotLimits` operation (IAM action
`ds:GetSnapshotLimits`), scoped to one {@link Directory}.

Reads the bound directory's manual snapshot limits — how many manual
snapshots exist versus the allowed maximum — so a backup function can
prune before taking a new snapshot. The directory id is injected from the
binding. Provide the implementation with
`Effect.provide(AWS.DirectoryService.GetSnapshotLimitsHttp)`.
### Managing Snapshots
**Example:** Check the Manual Snapshot Quota
```typescript
// init — bind the operation to the directory
const getSnapshotLimits = yield* AWS.DirectoryService.GetSnapshotLimits(directory);

// runtime
const { SnapshotLimits } = yield* getSnapshotLimits();
if (SnapshotLimits?.ManualSnapshotsLimitReached) {
  yield* Effect.logWarning("manual snapshot limit reached");
}
```

@binding

## ResetUserPassword

Runtime binding for the `ResetUserPassword` operation (IAM action
`ds:ResetUserPassword`), scoped to one {@link Directory}.

Resets the password of any user in the bound Simple AD or Managed
Microsoft AD directory — the backbone of a self-service password-reset
function. `NewPassword` is sensitive; pass a `Redacted` value so it never
leaks into logs. The directory id is injected from the binding. Provide
the implementation with
`Effect.provide(AWS.DirectoryService.ResetUserPasswordHttp)`.
### Managing Users
**Example:** Reset a User's Password
```typescript
// init — bind the operation to the directory
const resetUserPassword = yield* AWS.DirectoryService.ResetUserPassword(directory);

// runtime
yield* resetUserPassword({
  UserName: "jdoe",
  NewPassword: Redacted.make("N3w-Secret!"),
});
```

@binding
