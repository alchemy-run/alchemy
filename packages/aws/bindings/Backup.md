<!-- Docs for the generated AWS.Backup bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DeleteRecoveryPoint

Runtime binding for the `DeleteRecoveryPoint` operation (IAM action
`backup:DeleteRecoveryPoint`).

Deletes a recovery point from the bound {@link BackupVault} — e.g. a
retention janitor pruning on-demand backups. Provide the implementation
with `Effect.provide(AWS.Backup.DeleteRecoveryPointHttp)`.
### Recovery Points
**Example:** Prune A Recovery Point
```typescript
const deleteRecoveryPoint = yield* AWS.Backup.DeleteRecoveryPoint(vault);

yield* deleteRecoveryPoint({ RecoveryPointArn: recoveryPointArn });
```

@binding

## DeleteRecoveryPoint.Request

`DeleteRecoveryPoint` request with `BackupVaultName` injected from the
bound {@link BackupVault}.

## DescribeBackupJob

Runtime binding for the `DescribeBackupJob` operation (IAM action
`backup:DescribeBackupJob`).

Returns the details of a backup job by its ID — poll a job started with
`StartBackupJob` until it completes. Provide the implementation with
`Effect.provide(AWS.Backup.DescribeBackupJobHttp)`.
### Monitoring Backup Jobs
**Example:** Poll A Backup Job
```typescript
const describeBackupJob = yield* AWS.Backup.DescribeBackupJob();

const job = yield* describeBackupJob({ BackupJobId: jobId });
if (job.State === "COMPLETED") {
  yield* Effect.log(`recovery point: ${job.RecoveryPointArn}`);
}
```

@binding

## DescribeCopyJob

Runtime binding for the `DescribeCopyJob` operation (IAM action
`backup:DescribeCopyJob`).

Returns the details of a copy job by its ID — poll a job started with
`StartCopyJob` until it completes. Provide the implementation with
`Effect.provide(AWS.Backup.DescribeCopyJobHttp)`.
### Copying Recovery Points
**Example:** Poll A Copy Job
```typescript
const describeCopyJob = yield* AWS.Backup.DescribeCopyJob();

const { CopyJob } = yield* describeCopyJob({ CopyJobId: jobId });
```

@binding

## DescribeProtectedResource

Runtime binding for the `DescribeProtectedResource` operation (IAM action
`backup:DescribeProtectedResource`).

Returns backup metadata for a protected resource by its ARN — last backup
time, resource type, and latest recovery point. Provide the implementation
with `Effect.provide(AWS.Backup.DescribeProtectedResourceHttp)`.
### Protected Resources
**Example:** Look Up A Resource's Backup Status
```typescript
const describeProtectedResource =
  yield* AWS.Backup.DescribeProtectedResource();

const info = yield* describeProtectedResource({
  ResourceArn: tableArn,
});
yield* Effect.log(`last backup: ${info.LastBackupTime}`);
```

@binding

## DescribeRecoveryPoint

Runtime binding for the `DescribeRecoveryPoint` operation (IAM action
`backup:DescribeRecoveryPoint`).

Returns metadata for a recovery point stored in the bound
{@link BackupVault} — status, lifecycle, size, and restorability. Provide
the implementation with
`Effect.provide(AWS.Backup.DescribeRecoveryPointHttp)`.
### Recovery Points
**Example:** Inspect A Recovery Point
```typescript
const describeRecoveryPoint = yield* AWS.Backup.DescribeRecoveryPoint(vault);

const point = yield* describeRecoveryPoint({
  RecoveryPointArn: recoveryPointArn,
});
yield* Effect.log(`status: ${point.Status}`);
```

@binding

## DescribeRecoveryPoint.Request

`DescribeRecoveryPoint` request with `BackupVaultName` injected from the
bound {@link BackupVault}.

## DescribeRestoreJob

Runtime binding for the `DescribeRestoreJob` operation (IAM action
`backup:DescribeRestoreJob`).

Returns the details of a restore job by its ID — poll a job started with
`StartRestoreJob` until it completes. Provide the implementation with
`Effect.provide(AWS.Backup.DescribeRestoreJobHttp)`.
### Restoring Recovery Points
**Example:** Poll A Restore Job
```typescript
const describeRestoreJob = yield* AWS.Backup.DescribeRestoreJob();

const job = yield* describeRestoreJob({ RestoreJobId: jobId });
if (job.Status === "COMPLETED") {
  yield* Effect.log(`restored: ${job.CreatedResourceArn}`);
}
```

@binding

## GetRecoveryPointRestoreMetadata

Runtime binding for the `GetRecoveryPointRestoreMetadata` operation (IAM
action `backup:GetRecoveryPointRestoreMetadata`).

Returns the restore metadata for a recovery point in the bound
{@link BackupVault} — the key/value set passed to `StartRestoreJob` as its
`Metadata`. Provide the implementation with
`Effect.provide(AWS.Backup.GetRecoveryPointRestoreMetadataHttp)`.
### Restoring Recovery Points
**Example:** Fetch Restore Metadata Then Restore
```typescript
const getRestoreMetadata =
  yield* AWS.Backup.GetRecoveryPointRestoreMetadata(vault);
const startRestoreJob = yield* AWS.Backup.StartRestoreJob(role);

const { RestoreMetadata } = yield* getRestoreMetadata({
  RecoveryPointArn: recoveryPointArn,
});
yield* startRestoreJob({
  RecoveryPointArn: recoveryPointArn,
  Metadata: RestoreMetadata!,
});
```

@binding

## GetRecoveryPointRestoreMetadata.Request

`GetRecoveryPointRestoreMetadata` request with `BackupVaultName` injected
from the bound {@link BackupVault}.

## GetRestoreJobMetadata

Runtime binding for the `GetRestoreJobMetadata` operation (IAM action
`backup:GetRestoreJobMetadata`).

Returns the metadata of a restore job — the key/value set describing the
restored resource. Together with `PutRestoreValidationResult` this is the
restore-testing validation flow: AWS Backup invokes a validation Lambda
after a restore-test job completes, the Lambda inspects the restored
resource, then reports the verdict. Provide the implementation with
`Effect.provide(AWS.Backup.GetRestoreJobMetadataHttp)`.
### Restore Testing Validation
**Example:** Inspect A Restore Test's Metadata
```typescript
const getRestoreJobMetadata = yield* AWS.Backup.GetRestoreJobMetadata();

const { Metadata } = yield* getRestoreJobMetadata({
  RestoreJobId: restoreJobId,
});
yield* Effect.log(`restored resource metadata: ${JSON.stringify(Metadata)}`);
```

@binding

## GetSupportedResourceTypes

Runtime binding for the `GetSupportedResourceTypes` operation (IAM action
`backup:GetSupportedResourceTypes`).

Returns the AWS resource types AWS Backup supports (e.g. `DynamoDB`,
`EBS`, `RDS`). Provide the implementation with
`Effect.provide(AWS.Backup.GetSupportedResourceTypesHttp)`.
### Protected Resources
**Example:** List Supported Resource Types
```typescript
const getSupportedResourceTypes =
  yield* AWS.Backup.GetSupportedResourceTypes();

const { ResourceTypes } = yield* getSupportedResourceTypes();
```

@binding

## ListBackupJobs

Runtime binding for the `ListBackupJobs` operation (IAM action
`backup:ListBackupJobs`).

Lists the account's backup jobs from the last 30 days, with optional
filters (state, vault, resource type, time window). Provide the
implementation with `Effect.provide(AWS.Backup.ListBackupJobsHttp)`.
### Monitoring Backup Jobs
**Example:** List Running Backup Jobs
```typescript
const listBackupJobs = yield* AWS.Backup.ListBackupJobs();

const page = yield* listBackupJobs({ ByState: "RUNNING", MaxResults: 25 });
```

@binding

## ListCopyJobs

Runtime binding for the `ListCopyJobs` operation (IAM action
`backup:ListCopyJobs`).

Lists the account's copy jobs, with optional filters (state, destination
vault, resource type). Provide the implementation with
`Effect.provide(AWS.Backup.ListCopyJobsHttp)`.
### Copying Recovery Points
**Example:** List Running Copy Jobs
```typescript
const listCopyJobs = yield* AWS.Backup.ListCopyJobs();

const page = yield* listCopyJobs({ ByState: "RUNNING" });
```

@binding

## ListProtectedResources

Runtime binding for the `ListProtectedResources` operation (IAM action
`backup:ListProtectedResources`).

Lists the resources successfully backed up by AWS Backup — each entry
carries the resource ARN, type, and last-backup time. Provide the
implementation with `Effect.provide(AWS.Backup.ListProtectedResourcesHttp)`.
### Protected Resources
**Example:** List Protected Resources
```typescript
const listProtectedResources = yield* AWS.Backup.ListProtectedResources();

const page = yield* listProtectedResources({ MaxResults: 25 });
```

@binding

## ListRecoveryPointsByBackupVault

Runtime binding for the `ListRecoveryPointsByBackupVault` operation (IAM
action `backup:ListRecoveryPointsByBackupVault`, scoped to the vault ARN).

Lists the recovery points stored in the bound {@link BackupVault}, with
optional filters (resource ARN, resource type, plan, time window). Provide
the implementation with
`Effect.provide(AWS.Backup.ListRecoveryPointsByBackupVaultHttp)`.
### Recovery Points
**Example:** List A Vault's Recovery Points
```typescript
const listRecoveryPoints =
  yield* AWS.Backup.ListRecoveryPointsByBackupVault(vault);

const page = yield* listRecoveryPoints({ MaxResults: 25 });
```

@binding

## ListRecoveryPointsByBackupVault.Request

`ListRecoveryPointsByBackupVault` request with `BackupVaultName` injected
from the bound {@link BackupVault}.

## ListRecoveryPointsByResource

Runtime binding for the `ListRecoveryPointsByResource` operation (IAM
action `backup:ListRecoveryPointsByResource`).

Lists the recovery points for a specific protected resource by its ARN —
find the newest recovery point to restore from. Provide the implementation
with `Effect.provide(AWS.Backup.ListRecoveryPointsByResourceHttp)`.
### Recovery Points
**Example:** Find A Resource's Recovery Points
```typescript
const listRecoveryPointsByResource =
  yield* AWS.Backup.ListRecoveryPointsByResource();

const page = yield* listRecoveryPointsByResource({
  ResourceArn: tableArn,
  MaxResults: 10,
});
```

@binding

## ListRestoreJobs

Runtime binding for the `ListRestoreJobs` operation (IAM action
`backup:ListRestoreJobs`).

Lists the account's restore jobs, with optional filters (status, account,
time window). Provide the implementation with
`Effect.provide(AWS.Backup.ListRestoreJobsHttp)`.
### Restoring Recovery Points
**Example:** List Running Restore Jobs
```typescript
const listRestoreJobs = yield* AWS.Backup.ListRestoreJobs();

const page = yield* listRestoreJobs({ ByStatus: "RUNNING" });
```

@binding

## PutRestoreValidationResult

Runtime binding for the `PutRestoreValidationResult` operation (IAM action
`backup:PutRestoreValidationResult`).

Reports the result of a restore-test validation. This is the canonical
runtime use of AWS Backup: restore testing invokes a validation Lambda
after a restore-test job completes; the Lambda checks the restored
resource (fetch its metadata with `GetRestoreJobMetadata`, query the
restored table/volume, …) and posts `SUCCESSFUL` or `FAILED` back to the
restore job. Provide the implementation with
`Effect.provide(AWS.Backup.PutRestoreValidationResultHttp)`.
### Restore Testing Validation
**Example:** Report A Restore Test Verdict
```typescript
const putRestoreValidationResult =
  yield* AWS.Backup.PutRestoreValidationResult();

yield* putRestoreValidationResult({
  RestoreJobId: restoreJobId,
  ValidationStatus: "SUCCESSFUL",
  ValidationStatusMessage: "restored table row count matches source",
});
```

@binding

## StopBackupJob

Runtime binding for the `StopBackupJob` operation (IAM action
`backup:StopBackupJob`).

Cancels a running backup job. Only jobs for resource types that support
cancellation can be stopped. Provide the implementation with
`Effect.provide(AWS.Backup.StopBackupJobHttp)`.
### Monitoring Backup Jobs
**Example:** Cancel A Backup Job
```typescript
const stopBackupJob = yield* AWS.Backup.StopBackupJob();

yield* stopBackupJob({ BackupJobId: jobId });
```

@binding
