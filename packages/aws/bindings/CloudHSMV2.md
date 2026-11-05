<!-- Docs for the generated AWS.CloudHSMV2 bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## CopyBackupToRegion

Runtime binding for the `CopyBackupToRegion` operation (IAM action
`cloudhsm:CopyBackupToRegion`; the grant includes
`cloudhsm:TagResource` so user tags on the source backup can be copied to
the destination backup).

Copies a CloudHSM cluster backup into another region — the building block
of cross-region disaster-recovery automation. Provide the implementation
with `Effect.provide(AWS.CloudHSMV2.CopyBackupToRegionHttp)`.
### Managing Backups
**Example:** Copy A Backup For Disaster Recovery
```typescript
const copyBackupToRegion = yield* AWS.CloudHSMV2.CopyBackupToRegion();

const copy = yield* copyBackupToRegion({
  DestinationRegion: "us-east-1",
  BackupId: backupId,
});
// copy.DestinationBackup?.SourceBackup === backupId
```

@binding

## DeleteBackup

Runtime binding for the `DeleteBackup` operation (IAM action
`cloudhsm:DeleteBackup`).

Marks a CloudHSM backup for deletion — it enters `PENDING_DELETION` and
can still be recovered with `RestoreBackup` for 7 days. Pair with
`DescribeBackups` to build a backup-pruning job. Provide the
implementation with `Effect.provide(AWS.CloudHSMV2.DeleteBackupHttp)`.
### Managing Backups
**Example:** Prune A Backup
```typescript
const deleteBackup = yield* AWS.CloudHSMV2.DeleteBackup();

const deleted = yield* deleteBackup({ BackupId: backupId });
// deleted.Backup?.BackupState === "PENDING_DELETION"
```

@binding

## DeleteResourcePolicy

Runtime binding for the `DeleteResourcePolicy` operation (IAM action
`cloudhsm:DeleteResourcePolicy`).

Removes the resource policy from a CloudHSM backup, unsharing it (and
removing it from any RAM resource shares); clusters already created from
the backup are unaffected. Provide the implementation with
`Effect.provide(AWS.CloudHSMV2.DeleteResourcePolicyHttp)`.
### Sharing Backups
**Example:** Unshare A Backup
```typescript
const deleteResourcePolicy = yield* AWS.CloudHSMV2.DeleteResourcePolicy();

yield* deleteResourcePolicy({ ResourceArn: backupArn });
```

@binding

## DescribeBackups

Runtime binding for the `DescribeBackups` operation (IAM action
`cloudhsm:DescribeBackups`).

Lists the account's CloudHSM cluster backups (or backups shared with the
account when `Shared` is true), optionally filtered by backup id, cluster
id or state — the observation half of backup-retention and disaster-
recovery automation. Provide the implementation with
`Effect.provide(AWS.CloudHSMV2.DescribeBackupsHttp)`.
### Managing Backups
**Example:** List A Cluster's Ready Backups
```typescript
const describeBackups = yield* AWS.CloudHSMV2.DescribeBackups();

const page = yield* describeBackups({
  Filters: { clusterIds: [clusterId], states: ["READY"] },
});
```

@binding

## DescribeClusters

Runtime binding for the `DescribeClusters` operation (IAM action
`cloudhsm:DescribeClusters`).

Lists the account's CloudHSM clusters (optionally filtered by cluster id,
VPC or state) with each cluster's HSMs embedded — the building block of
cluster-health monitoring and automatic-HSM-replacement automation.
Provide the implementation with
`Effect.provide(AWS.CloudHSMV2.DescribeClustersHttp)`.
### Monitoring Clusters
**Example:** Check A Cluster's HSM Health
```typescript
const describeClusters = yield* AWS.CloudHSMV2.DescribeClusters();

const page = yield* describeClusters({
  Filters: { clusterIds: [clusterId] },
});
const active = page.Clusters?.[0]?.Hsms?.filter(
  (hsm) => hsm.State === "ACTIVE",
);
```

@binding

## GetResourcePolicy

Runtime binding for the `GetResourcePolicy` operation (IAM action
`cloudhsm:GetResourcePolicy`).

Reads the resource policy attached to a CloudHSM backup (backups are the
only CloudHSM resource that supports policies — they govern cross-account
backup sharing). Provide the implementation with
`Effect.provide(AWS.CloudHSMV2.GetResourcePolicyHttp)`.
### Sharing Backups
**Example:** Read A Backup's Sharing Policy
```typescript
const getResourcePolicy = yield* AWS.CloudHSMV2.GetResourcePolicy();

const { Policy } = yield* getResourcePolicy({ ResourceArn: backupArn });
```

@binding

## InitializeCluster

Runtime binding for the `InitializeCluster` operation (IAM action
`cloudhsm:InitializeCluster`).

Claims an `UNINITIALIZED` CloudHSM cluster by submitting the cluster
certificate (the cluster's CSR signed by your issuing CA) and the CA's
root certificate — lets a Function automate the activation ceremony
around your CA. The certificates are public key material. Provide the
implementation with `Effect.provide(AWS.CloudHSMV2.InitializeClusterHttp)`.
### Activating a Cluster
**Example:** Submit The Signed Cluster Certificate
```typescript
const initializeCluster = yield* AWS.CloudHSMV2.InitializeCluster();

const result = yield* initializeCluster({
  ClusterId: clusterId,
  SignedCert: signedClusterCertPem,
  TrustAnchor: issuingCaRootPem,
});
// result.State === "INITIALIZE_IN_PROGRESS"
```

@binding

## ModifyBackupAttributes

Runtime binding for the `ModifyBackupAttributes` operation (IAM action
`cloudhsm:ModifyBackupAttributes`).

Toggles a backup's `NeverExpires` attribute — pin a golden backup so the
cluster's retention policy never deletes it, or unpin it again. Provide
the implementation with
`Effect.provide(AWS.CloudHSMV2.ModifyBackupAttributesHttp)`.
### Managing Backups
**Example:** Pin A Backup Forever
```typescript
const modifyBackupAttributes =
  yield* AWS.CloudHSMV2.ModifyBackupAttributes();

yield* modifyBackupAttributes({ BackupId: backupId, NeverExpires: true });
```

@binding

## PutResourcePolicy

Runtime binding for the `PutResourcePolicy` operation (IAM action
`cloudhsm:PutResourcePolicy`).

Creates or replaces the resource policy on a CloudHSM backup, sharing a
`READY` backup you own with other accounts (AWS recommends RAM for
discoverable multi-resource shares; this is the direct API). Provide the
implementation with `Effect.provide(AWS.CloudHSMV2.PutResourcePolicyHttp)`.
### Sharing Backups
**Example:** Share A Backup With Another Account
```typescript
const putResourcePolicy = yield* AWS.CloudHSMV2.PutResourcePolicy();

yield* putResourcePolicy({
  ResourceArn: backupArn,
  Policy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { AWS: "arn:aws:iam::123456789012:root" },
      Action: ["cloudhsm:DescribeBackups"],
      Resource: backupArn,
    }],
  }),
});
```

@binding

## RestoreBackup

Runtime binding for the `RestoreBackup` operation (IAM action
`cloudhsm:RestoreBackup`).

Recovers a CloudHSM backup in the `PENDING_DELETION` state back to
`READY` — the undo for `DeleteBackup`, available for 7 days after the
delete. Provide the implementation with
`Effect.provide(AWS.CloudHSMV2.RestoreBackupHttp)`.
### Managing Backups
**Example:** Undo A Backup Deletion
```typescript
const restoreBackup = yield* AWS.CloudHSMV2.RestoreBackup();

const restored = yield* restoreBackup({ BackupId: backupId });
// restored.Backup?.BackupState === "READY"
```

@binding
