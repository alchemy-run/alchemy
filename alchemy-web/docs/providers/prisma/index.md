# Prisma

Prisma is a next-generation ORM and database platform that provides type-safe database access, automated migrations, and powerful development tools for modern applications.

[Official Website](https://prisma.io) | [Documentation](https://docs.prisma.io) | [Platform](https://cloud.prisma.io)

## Resources

- [Project](./project.md) - Create and manage Prisma projects with environments and database connections

## Example Usage

```ts
import alchemy from "alchemy";
import { PrismaProject } from "alchemy/prisma";

const app = await alchemy("my-app");

// Create a Prisma project
const project = await PrismaProject("my-project", {
  name: "My Application",
  description: "A modern web application",
  region: "us-east-1",
  private: false,
});

console.log("Project ID:", project.id);
console.log("Environments:", project.environments.length);

await app.finalize();
```