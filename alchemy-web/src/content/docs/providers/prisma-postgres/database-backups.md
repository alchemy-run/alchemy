---
title: DatabaseBackups
description: List Prisma Postgres backups and retention information.
---

`DatabaseBackups` fetches the backup catalog for a database along with retention metadata. The resource is read-only and can be combined with `Database` to restore backups.

## List Backups

```ts
import { DatabaseBackups } from "alchemy/prisma/postgres";

const backups = await DatabaseBackups("backups", {
  database,
  limit: 10,
});

console.log(backups.backups.map((backup) => backup.id));
```

## Use the Most Recent Backup

```ts
import { Database, DatabaseBackups } from "alchemy/prisma/postgres";

const backups = await DatabaseBackups("backups", { database });

if (!backups.mostRecent) {
  throw new Error("No backups available");
}

await Database("restored", {
  project,
  name: "restored",
  region: "us-east-1",
  fromDatabase: {
    database,
    backupId: backups.mostRecent.id,
  },
});
```
