# PrismaDatabase

Creates and manages databases within Prisma projects for data storage and management.

## Properties

### Required

- **`project`** - The project that this database belongs to. Can be a `PrismaProject` resource or project ID string.
- **`name`** - Name of the database.

### Optional

- **`region`** - Region where the database will be deployed. One of: `"us-east-1"`, `"us-west-1"`, `"eu-west-3"`, `"ap-northeast-1"`, `"ap-southeast-1"`. Defaults to `"us-east-1"`.
- **`isDefault`** - Whether this is the default database for the project. Defaults to `false`.
- **`baseUrl`** - Base URL for Prisma API. Defaults to `https://api.prisma.io`.
- **`apiKey`** - API Key to use (overrides `PRISMA_API_KEY` env var).

## Outputs

- **`id`** - The ID of the database.
- **`projectId`** - The ID of the project this database belongs to.
- **`name`** - Name of the database.
- **`region`** - Region where the database is deployed.
- **`isDefault`** - Whether this is the default database for the project.
- **`connectionString`** - Database connection string (only available during creation).
- **`status`** - Database status.
- **`apiKeys`** - API keys/connections for this database.
- **`createdAt`** - Time at which the database was created.

## Examples

### Create a basic database

```ts
import { PrismaProject, PrismaDatabase } from "alchemy/prisma";

const project = await PrismaProject("my-project", {
  name: "My App",
  description: "My application project"
});

const database = await PrismaDatabase("my-database", {
  project: project,
  name: "my-app-db",
  region: "us-east-1"
});

console.log("Database ID:", database.id);
console.log("Connection String:", database.connectionString);
```

### Create a default database

```ts
import { PrismaDatabase } from "alchemy/prisma";

const database = await PrismaDatabase("default-db", {
  project: "project-123",
  name: "production",
  region: "us-east-1",
  isDefault: true
});
```

### Create database with custom region

```ts
import { PrismaDatabase } from "alchemy/prisma";

const database = await PrismaDatabase("eu-database", {
  project: project,
  name: "eu-production",
  region: "eu-west-3"
});
```

### Access database properties

```ts
const database = await PrismaDatabase("my-db", {
  project: project,
  name: "analytics",
  region: "us-west-1"
});

console.log("Database region:", database.region);
console.log("Is default:", database.isDefault);
console.log("Created at:", database.createdAt);
console.log("Status:", database.status);
```

## Notes

- Database names must be unique within a project
- Most database properties are immutable after creation
- Only one database per project can be marked as default
- Connection strings are only available during the initial creation response
- Use `PrismaConnection` resources to create additional connection strings