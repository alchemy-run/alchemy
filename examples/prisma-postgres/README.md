# Prisma Postgres Example

This example provisions a Prisma Postgres project, database, and connection string using Alchemy.

## Prerequisites

1. Create a Prisma Postgres workspace service token.
2. Export the token before running the example:

   ```bash
   export PRISMA_SERVICE_TOKEN="sk_..."
   ```

## Usage

```bash
bun i
bun run alchemy.run.ts
```

The script prints the generated database connection string to stdout.

To tear down the resources:

```bash
bun run destroy
```
