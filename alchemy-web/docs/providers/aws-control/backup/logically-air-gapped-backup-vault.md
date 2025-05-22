---
title: Managing AWS Backup LogicallyAirGappedBackupVaults with Alchemy
description: Learn how to create, update, and manage AWS Backup LogicallyAirGappedBackupVaults using Alchemy Cloud Control.
---

# LogicallyAirGappedBackupVault

The LogicallyAirGappedBackupVault resource lets you create and manage [AWS Backup LogicallyAirGappedBackupVaults](https://docs.aws.amazon.com/backup/latest/userguide/) using AWS Cloud Control API.

http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-backup-logicallyairgappedbackupvault.html

## Minimal Example

```ts
import AWS from "alchemy/aws/control";

const logicallyairgappedbackupvault = await AWS.Backup.LogicallyAirGappedBackupVault(
  "logicallyairgappedbackupvault-example",
  {
    BackupVaultName: "logicallyairgappedbackupvault-backupvault",
    MaxRetentionDays: 1,
    MinRetentionDays: 1,
  }
);
```

