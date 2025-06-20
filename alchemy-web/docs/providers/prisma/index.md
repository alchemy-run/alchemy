# Prisma

Prisma is a next-generation ORM and database platform that provides type-safe database access, automated migrations, and powerful development tools for modern applications.

[Official Website](https://prisma.io) | [Documentation](https://docs.prisma.io) | [Platform](https://cloud.prisma.io)

## Resources

- [Project](./project.md) - Create and manage Prisma projects with environments and database connections
- [Database](./database.md) - Create and manage databases within Prisma projects
- [Connection](./connection.md) - Create and manage database connection strings for secure access
- [Backup](./backup.md) - Access database backups and restore functionality

## Example Usage

```ts
import alchemy from "alchemy";
import { PrismaProject, PrismaDatabase, PrismaConnection, PrismaBackup } from "alchemy/prisma";

const app = await alchemy("my-app");

// Create a Prisma project
const project = await PrismaProject("my-project", {
  name: "My Application",
  description: "A modern web application",
  region: "us-east-1",
  private: false,
});

// Create a database in the project
const database = await PrismaDatabase("main-db", {
  project: project,
  name: "production",
  region: "us-east-1",
  isDefault: true,
});

// Create a connection string for the database
const connection = await PrismaConnection("app-connection", {
  project: project,
  database: database,
  name: "web-app",
});

// Access backup information
const backups = await PrismaBackup("db-backups", {
  project: project,
  database: database,
});

console.log("Project ID:", project.id);
console.log("Database ID:", database.id);
console.log("Connection String:", await connection.connectionString.unencrypted);
console.log("Available backups:", backups.backups.length);

await app.finalize();
```