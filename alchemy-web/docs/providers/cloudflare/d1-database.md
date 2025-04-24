# D1Database

The D1Database component lets you add [Cloudflare D1 Databases](https://developers.cloudflare.com/d1/) to your app.

# Minimal Example

Create a basic D1 database with default settings.

```ts
import { D1Database } from "alchemy/cloudflare";

const database = await D1Database("my-db", {
  name: "my-db"
});
```

# With Read Replication

Enable automatic read replication for better performance.

```ts
import { D1Database } from "alchemy/cloudflare";

const database = await D1Database("replicated-db", {
  name: "replicated-db",
  readReplication: {
    mode: "auto"
  }
});
```

# With Migrations

Apply SQL migrations when creating or updating the database.

```ts
import { D1Database } from "alchemy/cloudflare";

const database = await D1Database("db-with-migrations", {
  name: "db-with-migrations", 
  migrationsDir: "./migrations",
  migrationsTable: "migrations"
});
```

# Bind to a Worker

Bind the D1 database to a Cloudflare Worker.

```ts
import { Worker, D1Database } from "alchemy/cloudflare";

const database = await D1Database("my-db", {
  name: "my-db"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    DB: database
  }
});
```