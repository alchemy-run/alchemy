---
title: DatabaseConnection
description: Create and rotate Prisma Postgres database connection strings.
---

Use `DatabaseConnection` to issue connection strings for Prisma Postgres databases. Each invocation generates a new API key and connection string.

## Create a Connection

```ts
import { DatabaseConnection } from "alchemy/prisma/postgres";

const connection = await DatabaseConnection("application", {
  database,
  name: "application",
});

console.log(connection.connectionString.unencrypted);
```

## Rotate If Missing

If the underlying connection is deleted, rerunning the resource automatically creates a replacement with a fresh secret:

```ts
await DatabaseConnection("application", {
  database,
  name: "application",
});
```

## Using the Secret in Environment Variables

```ts
const connection = await DatabaseConnection("application", {
  database,
  name: "application",
});

authEnv.PRISMA_DATABASE_URL = connection.connectionString;
```
