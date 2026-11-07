<!-- Docs for the generated AWS.RedshiftServerless bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## ConvertRecoveryPointToSnapshot

Runtime binding for the `ConvertRecoveryPointToSnapshot` operation (IAM actions
`redshift-serverless:ConvertRecoveryPointToSnapshot` +
`redshift-serverless:TagResource`).

Converts an automatic recovery point into a manual snapshot so it
outlives the 24-hour recovery-point window. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.ConvertRecoveryPointToSnapshotHttp)`.
### Working with Recovery Points
**Example:** Preserve a Recovery Point as a Snapshot
```typescript
// init — resolve the runtime client
const convert = yield* AWS.RedshiftServerless.ConvertRecoveryPointToSnapshot();

yield* convert({ recoveryPointId, snapshotName: `preserved-${runId}` });
```

@binding

## CreateSnapshot

Runtime binding for the `CreateSnapshot` operation (IAM actions
`redshift-serverless:CreateSnapshot` +
`redshift-serverless:TagResource`).

Takes a manual snapshot of the bound {@link Namespace} — e.g. a
pre-migration backup function or a scheduled snapshot-rotation job. The
namespace name is injected from the binding. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.CreateSnapshotHttp)`.
### Managing Snapshots
**Example:** Take a Manual Snapshot
```typescript
// init — resolve the runtime client
const createSnapshot = yield* AWS.RedshiftServerless.CreateSnapshot(namespace);

// runtime
yield* createSnapshot({
  snapshotName: `pre-migration-${runId}`,
  retentionPeriod: 7,
});
```

@binding

## DeleteSnapshot

Runtime binding for the `DeleteSnapshot` operation (IAM actions
`redshift-serverless:DeleteSnapshot`).

Deletes a manual snapshot — the cleanup half of a snapshot-rotation
job. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.DeleteSnapshotHttp)`.
### Managing Snapshots
**Example:** Delete an Expired Snapshot
```typescript
// init — resolve the runtime client
const deleteSnapshot = yield* AWS.RedshiftServerless.DeleteSnapshot();

yield* deleteSnapshot({ snapshotName: "pre-migration-1" });
```

@binding

## GetIdentityCenterAuthToken

Runtime binding for the `GetIdentityCenterAuthToken` operation (IAM actions
`redshift-serverless:GetIdentityCenterAuthToken`).

Mints an IAM Identity Center authentication token for up to 20
workgroups — the trusted-identity-propagation alternative to
{@link Connect}'s `GetCredentials` flow. The response `token` decodes to
`Redacted<string>`. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.GetIdentityCenterAuthTokenHttp)`.
### Connecting to a Workgroup
**Example:** Mint an Identity Center Token
```typescript
// init — resolve the runtime client
const getToken = yield* AWS.RedshiftServerless.GetIdentityCenterAuthToken();

const { token, expirationTime } = yield* getToken({
  workgroupNames: [workgroupName],
});
```

@binding

## GetRecoveryPoint

Runtime binding for the `GetRecoveryPoint` operation (IAM actions
`redshift-serverless:GetRecoveryPoint`).

Reads one automatic recovery point by id. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.GetRecoveryPointHttp)`.
### Working with Recovery Points
**Example:** Inspect a Recovery Point
```typescript
// init — resolve the runtime client
const getRecoveryPoint = yield* AWS.RedshiftServerless.GetRecoveryPoint();

const { recoveryPoint } = yield* getRecoveryPoint({ recoveryPointId });
```

@binding

## GetSnapshot

Runtime binding for the `GetSnapshot` operation (IAM actions
`redshift-serverless:GetSnapshot`).

Reads one snapshot by name or ARN — e.g. polling a snapshot taken with
{@link CreateSnapshot} until its `status` reaches `AVAILABLE`. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.GetSnapshotHttp)`.
### Managing Snapshots
**Example:** Poll a Snapshot Until Available
```typescript
// init — resolve the runtime client
const getSnapshot = yield* AWS.RedshiftServerless.GetSnapshot();

const { snapshot } = yield* getSnapshot({ snapshotName: "pre-migration-1" });
// snapshot?.status -> "CREATING" | "AVAILABLE" | ...
```

@binding

## GetTableRestoreStatus

Runtime binding for the `GetTableRestoreStatus` operation (IAM actions
`redshift-serverless:GetTableRestoreStatus`).

Polls one table-restore request started with
{@link RestoreTableFromSnapshot} or {@link RestoreTableFromRecoveryPoint}. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.GetTableRestoreStatusHttp)`.
### Restoring Data
**Example:** Poll a Table Restore
```typescript
// init — resolve the runtime client
const getTableRestoreStatus = yield* AWS.RedshiftServerless.GetTableRestoreStatus();

const { tableRestoreStatus } = yield* getTableRestoreStatus({
  tableRestoreRequestId,
});
```

@binding

## ListRecoveryPoints

Runtime binding for the `ListRecoveryPoints` operation (IAM actions
`redshift-serverless:ListRecoveryPoints`).

Lists the automatic recovery points Redshift Serverless created in the
last 24 hours, optionally filtered by namespace — the discovery half of
point-in-time recovery tooling. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.ListRecoveryPointsHttp)`.
### Working with Recovery Points
**Example:** List Recovery Points for a Namespace
```typescript
// init — resolve the runtime client
const listRecoveryPoints = yield* AWS.RedshiftServerless.ListRecoveryPoints();

const { recoveryPoints } = yield* listRecoveryPoints({ namespaceName });
```

@binding

## ListSnapshots

Runtime binding for the `ListSnapshots` operation (IAM actions
`redshift-serverless:ListSnapshots`).

Lists snapshots in the account, optionally filtered by namespace or
time window — the discovery half of snapshot-rotation and DR tooling. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.ListSnapshotsHttp)`.
### Managing Snapshots
**Example:** List Snapshots for a Namespace
```typescript
// init — resolve the runtime client
const listSnapshots = yield* AWS.RedshiftServerless.ListSnapshots();

const { snapshots } = yield* listSnapshots({ namespaceName });
```

@binding

## ListTableRestoreStatus

Runtime binding for the `ListTableRestoreStatus` operation (IAM actions
`redshift-serverless:ListTableRestoreStatus`).

Lists table-restore requests, optionally filtered by namespace or
workgroup. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.ListTableRestoreStatusHttp)`.
### Restoring Data
**Example:** List Table Restores for a Namespace
```typescript
// init — resolve the runtime client
const listTableRestoreStatus = yield* AWS.RedshiftServerless.ListTableRestoreStatus();

const { tableRestoreStatuses } = yield* listTableRestoreStatus({ namespaceName });
```

@binding

## RestoreFromRecoveryPoint

Runtime binding for the `RestoreFromRecoveryPoint` operation (IAM actions
`redshift-serverless:RestoreFromRecoveryPoint`).

Restores the bound {@link Namespace} from an automatic recovery point —
point-in-time recovery within the last 24 hours. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.RestoreFromRecoveryPointHttp)`.
### Restoring Data
**Example:** Restore a Namespace from a Recovery Point
```typescript
// init — resolve the runtime client
const restore = yield* AWS.RedshiftServerless.RestoreFromRecoveryPoint(namespace);

yield* restore({ workgroupName, recoveryPointId });
```

@binding

## RestoreFromSnapshot

Runtime binding for the `RestoreFromSnapshot` operation (IAM actions
`redshift-serverless:RestoreFromSnapshot`).

Restores the bound {@link Namespace} from a snapshot — a
disaster-recovery runbook step. The namespace name is injected from the
binding; pass the serving workgroup and the snapshot to restore. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.RestoreFromSnapshotHttp)`.
### Restoring Data
**Example:** Restore a Namespace from a Snapshot
```typescript
// init — resolve the runtime client
const restoreFromSnapshot = yield* AWS.RedshiftServerless.RestoreFromSnapshot(namespace);

yield* restoreFromSnapshot({
  workgroupName,
  snapshotName: "pre-migration-1",
});
```

@binding

## RestoreTableFromRecoveryPoint

Runtime binding for the `RestoreTableFromRecoveryPoint` operation (IAM actions
`redshift-serverless:RestoreTableFromRecoveryPoint`).

Restores a single table from an automatic recovery point into the bound
{@link Namespace} under a new name. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.RestoreTableFromRecoveryPointHttp)`.
### Restoring Data
**Example:** Restore One Table from a Recovery Point
```typescript
// init — resolve the runtime client
const restoreTable = yield* AWS.RedshiftServerless.RestoreTableFromRecoveryPoint(namespace);

yield* restoreTable({
  workgroupName,
  recoveryPointId,
  sourceDatabaseName: "dev",
  sourceTableName: "orders",
  newTableName: "orders_restored",
});
```

@binding

## RestoreTableFromSnapshot

Runtime binding for the `RestoreTableFromSnapshot` operation (IAM actions
`redshift-serverless:RestoreTableFromSnapshot`).

Restores a single table from a snapshot into the bound
{@link Namespace} under a new name — undo for a bad table mutation
without rolling back the whole namespace. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.RestoreTableFromSnapshotHttp)`.
### Restoring Data
**Example:** Restore One Table from a Snapshot
```typescript
// init — resolve the runtime client
const restoreTable = yield* AWS.RedshiftServerless.RestoreTableFromSnapshot(namespace);

yield* restoreTable({
  workgroupName,
  snapshotName: "pre-migration-1",
  sourceDatabaseName: "dev",
  sourceTableName: "orders",
  newTableName: "orders_restored",
});
```

@binding

## UpdateSnapshot

Runtime binding for the `UpdateSnapshot` operation (IAM actions
`redshift-serverless:UpdateSnapshot`).

Changes a snapshot's retention period — e.g. extending retention on a
snapshot that an audit flagged for preservation. Provide the implementation with
`Effect.provide(AWS.RedshiftServerless.UpdateSnapshotHttp)`.
### Managing Snapshots
**Example:** Extend a Snapshot's Retention
```typescript
// init — resolve the runtime client
const updateSnapshot = yield* AWS.RedshiftServerless.UpdateSnapshot();

yield* updateSnapshot({ snapshotName: "pre-migration-1", retentionPeriod: 30 });
```

@binding
