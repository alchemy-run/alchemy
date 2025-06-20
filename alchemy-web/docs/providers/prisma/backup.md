# PrismaBackup

Accesses Prisma database backups and provides restore functionality. This is a read-only resource that lists available backups and can restore them to new databases.

## Properties

### Required

- **`project`** - The project that the database belongs to. Can be a `PrismaProject` resource or project ID string.
- **`database`** - The database to access backups for. Can be a `PrismaDatabase` resource or database ID string.

### Optional

- **`restore`** - Configuration for restoring a backup to a new database:
  - **`backupId`** - The backup ID to restore from.
  - **`targetDatabaseName`** - Name of the new database to restore to.
- **`baseUrl`** - Base URL for Prisma API. Defaults to `https://api.prisma.io`.
- **`apiKey`** - API Key to use (overrides `PRISMA_API_KEY` env var).

## Outputs

- **`projectId`** - The ID of the project.
- **`databaseId`** - The ID of the database these backups belong to.
- **`backups`** - List of available backups, each containing:
  - **`id`** - Backup ID.
  - **`createdAt`** - Time when the backup was created.
  - **`backupType`** - Type of backup (`"full"` or `"incremental"`).
  - **`size`** - Size of the backup in bytes.
  - **`status`** - Status of the backup (`"running"`, `"completed"`, `"failed"`, or `"unknown"`).
- **`meta`** - Backup metadata:
  - **`backupRetentionDays`** - Number of days backups are retained.
- **`restoredDatabase`** - If a restore was requested, the restored database details:
  - **`id`** - ID of the restored database.
  - **`name`** - Name of the restored database.
  - **`region`** - Region of the restored database.
  - **`isDefault`** - Whether the restored database is default.
  - **`status`** - Status of the restored database.
  - **`createdAt`** - Creation time of the restored database.

## Examples

### List database backups

```ts
import { PrismaProject, PrismaDatabase, PrismaBackup } from "alchemy/prisma";

const project = await PrismaProject("my-project", {
  name: "My App"
});

const database = await PrismaDatabase("my-database", {
  project: project,
  name: "production"
});

const backups = await PrismaBackup("db-backups", {
  project: project,
  database: database
});

console.log(`Found ${backups.backups.length} backups`);
console.log(`Retention: ${backups.meta.backupRetentionDays} days`);

backups.backups.forEach(backup => {
  console.log(`Backup ${backup.id}: ${backup.backupType} (${backup.status})`);
  console.log(`  Created: ${backup.createdAt}`);
  console.log(`  Size: ${backup.size} bytes`);
});
```

### Restore a backup to a new database

```ts
import { PrismaBackup } from "alchemy/prisma";

const backups = await PrismaBackup("restore-backup", {
  project: project,
  database: database,
  restore: {
    backupId: "backup-123",
    targetDatabaseName: "restored-production"
  }
});

if (backups.restoredDatabase) {
  console.log(`Restored to database: ${backups.restoredDatabase.id}`);
  console.log(`Database name: ${backups.restoredDatabase.name}`);
  console.log(`Status: ${backups.restoredDatabase.status}`);
}
```

### Find latest completed backup

```ts
const backups = await PrismaBackup("latest-backup", {
  project: "project-123",
  database: "database-456"
});

const latestBackup = backups.backups
  .filter(b => b.status === "completed")
  .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

if (latestBackup) {
  console.log("Latest backup:", latestBackup.id);
  console.log("Created:", latestBackup.createdAt);
  console.log("Type:", latestBackup.backupType);
  console.log("Size:", latestBackup.size);
}
```

### Filter backups by type and status

```ts
const backups = await PrismaBackup("filtered-backups", {
  project: project,
  database: database
});

// Get all completed full backups
const fullBackups = backups.backups.filter(b => 
  b.backupType === "full" && b.status === "completed"
);

// Get all recent backups (last 7 days)
const recentBackups = backups.backups.filter(b => {
  const backupDate = new Date(b.createdAt);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return backupDate > weekAgo;
});

console.log(`Full backups: ${fullBackups.length}`);
console.log(`Recent backups: ${recentBackups.length}`);
```

### Check backup retention policy

```ts
const backups = await PrismaBackup("backup-policy", {
  project: project,
  database: database
});

console.log(`Backup retention: ${backups.meta.backupRetentionDays} days`);

// Calculate oldest backup date based on retention policy
const retentionDate = new Date(Date.now() - backups.meta.backupRetentionDays * 24 * 60 * 60 * 1000);
console.log(`Backups older than ${retentionDate.toISOString()} will be deleted`);
```

## Notes

- This is a read-only resource - backups are created automatically by Prisma
- Backup restoration creates a new database rather than overwriting the existing one
- Restoration is an asynchronous operation that may take time to complete
- Check the `status` field of restored databases to monitor restoration progress
- Backup retention policies are configured at the project level
- Full backups contain complete database snapshots
- Incremental backups contain only changes since the last backup
- Use backup restoration for disaster recovery and data migration scenarios