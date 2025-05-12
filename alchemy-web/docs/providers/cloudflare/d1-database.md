---
title: Managing Cloudflare D1 Databases with Alchemy
description: Learn how to create, query, and manage Cloudflare D1 Databases using Alchemy for serverless SQL databases.
---

# D1Database

The D1Database component lets you add [Cloudflare D1 Databases](https://developers.cloudflare.com/d1/) to your app.

# Minimal Example

Create a basic D1 database with default settings.

```ts
import { D1Database } from "alchemy/cloudflare";

const db = await D1Database("my-db", {
  name: "my-db"
});
```

# With Migrations

Create a database with SQL migrations.

```ts
import { D1Database } from "alchemy/cloudflare";

const db = await D1Database("users-db", {
  name: "users-db",
  migrationsDir: "./migrations",
  migrationsTable: "schema_migrations" 
});
```

# With Location Hint

Create a database with a specific location hint for optimal performance.

```ts
import { D1Database } from "alchemy/cloudflare";

const db = await D1Database("eu-db", {
  name: "eu-db",
  primaryLocationHint: "weur",
  readReplication: {
    mode: "auto"
  }
});
```

# Bind to a Worker

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