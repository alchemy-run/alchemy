---
title: Database
description: Provision Prisma Postgres databases, including restoring from backups.
---

`Database` creates additional databases within a Prisma Postgres project. Databases inherit workspace access from their parent project and support restoring from backups created by Prisma.

## Create a Database

```ts
import { Database } from "alchemy/prisma/postgres";

const database = await Database("primary", {
  project,
  name: "primary",
  region: "us-east-1",
});
```

## Disable Adoption

Force a new database instead of reusing an existing one:

```ts
import { Database } from "alchemy/prisma/postgres";

const database = await Database("isolated", {
  project,
  name: "isolated",
  region: "eu-central-1",
  adopt: false,
});
```

## Restore from Backup

Restore a database from another database and an optional backup id:

```ts
import { Database, DatabaseBackups } from "alchemy/prisma/postgres";

const backups = await DatabaseBackups("backups", { database: sourceDatabase });

const restored = await Database("restore", {
  project,
  name: "restore",
  region: "us-east-1",
  fromDatabase: {
    database: sourceDatabase,
    backupId: backups.mostRecent?.id,
  },
});
```

## Promote to Default Database

Set `isDefault` to true to promote the database when the workspace allows it:

```ts
const database = await Database("default", {
  project,
  name: "default",
  region: "us-east-1",
  isDefault: true,
});
```
