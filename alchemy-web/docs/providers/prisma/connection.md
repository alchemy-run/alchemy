# PrismaConnection

Creates and manages database connection strings for secure access to Prisma databases.

## Properties

### Required

- **`project`** - The project that the database belongs to. Can be a `PrismaProject` resource or project ID string.
- **`database`** - The database to create a connection for. Can be a `PrismaDatabase` resource or database ID string.
- **`name`** - Name of the connection.

### Optional

- **`baseUrl`** - Base URL for Prisma API. Defaults to `https://api.prisma.io`.
- **`apiKey`** - API Key to use (overrides `PRISMA_API_KEY` env var).

## Outputs

- **`id`** - The ID of the connection.
- **`projectId`** - The ID of the project.
- **`databaseId`** - The ID of the database this connection belongs to.
- **`name`** - Name of the connection.
- **`connectionString`** - Database connection string (sensitive, wrapped in `Secret`).
- **`createdAt`** - Time at which the connection was created.

## Examples

### Create a database connection

```ts
import { PrismaProject, PrismaDatabase, PrismaConnection } from "alchemy/prisma";

const project = await PrismaProject("my-project", {
  name: "My App"
});

const database = await PrismaDatabase("my-database", {
  project: project,
  name: "production"
});

const connection = await PrismaConnection("app-connection", {
  project: project,
  database: database,
  name: "app-production"
});

console.log("Connection ID:", connection.id);
console.log("Created at:", connection.createdAt);
```

### Create connection with explicit IDs

```ts
import { PrismaConnection } from "alchemy/prisma";

const connection = await PrismaConnection("backup-connection", {
  project: "project-123",
  database: "database-456",
  name: "backup-reader"
});
```

### Access connection string

```ts
const connection = await PrismaConnection("my-connection", {
  project: project,
  database: database,
  name: "web-app"
});

// The connection string is wrapped in a Secret for security
const connectionString = await connection.connectionString.unencrypted;
console.log("Connection string:", connectionString);

// Use in your application
process.env.DATABASE_URL = connectionString;
```

### Multiple connections for different purposes

```ts
// Read-write connection for the main application
const appConnection = await PrismaConnection("app-connection", {
  project: project,
  database: database,
  name: "main-app"
});

// Read-only connection for analytics
const analyticsConnection = await PrismaConnection("analytics-connection", {
  project: project,
  database: database,
  name: "analytics-readonly"
});

// Backup connection for maintenance tasks
const backupConnection = await PrismaConnection("backup-connection", {
  project: project,
  database: database,
  name: "backup-tasks"
});
```

### Using connection in Prisma schema

```ts
const connection = await PrismaConnection("schema-connection", {
  project: project,
  database: database,
  name: "schema-access"
});

// Use the connection string in your Prisma configuration
const databaseUrl = await connection.connectionString.unencrypted;

// In your .env file or environment configuration:
// DATABASE_URL=<databaseUrl>
```

## Notes

- Connection strings provide secure access to your Prisma database
- Each connection has its own unique credentials
- Connection strings are sensitive and wrapped in `Secret` objects
- Multiple connections can be created for the same database
- Connections are immutable once created
- Use descriptive names to identify the purpose of each connection
- Always handle connection strings securely in production environments