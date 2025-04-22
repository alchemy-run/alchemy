# D1Database

The D1Database component lets you create and manage [Cloudflare D1 Databases](https://developers.cloudflare.com/d1/) - serverless SQL databases built on SQLite.

# Minimal Example

Creates a basic D1 database with default settings.

```ts
import { D1Database } from "alchemy/cloudflare";

const db = await D1Database("my-db", {
  name: "my-db"
});
```

# With Migrations

Creates a database and applies SQL migrations from a directory.

```ts
import { D1Database } from "alchemy/cloudflare";

const db = await D1Database("my-db", {
  name: "my-db",
  migrationsDir: "./migrations",
  migrationsTable: "migrations" // Optional, defaults to "d1_migrations"
});
```

# With Location Hint

Creates a database with a specific geographical location hint.

```ts
import { D1Database } from "alchemy/cloudflare";

const db = await D1Database("west-us-db", {
  name: "west-us-db", 
  primaryLocationHint: "wnam"
});
```

# With Read Replication

Creates a database with automatic read replication enabled.

```ts
import { D1Database } from "alchemy/cloudflare";

const db = await D1Database("replicated-db", {
  name: "replicated-db",
  readReplication: {
    mode: "auto"
  }
});
```

# Bind to a Worker

Binds a D1 database to a Cloudflare Worker.

```ts
import { Worker, D1Database } from "alchemy/cloudflare";

const db = await D1Database("my-db", {
  name: "my-db"
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    DB: db
  }
});
```