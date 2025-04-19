# D1Database

The D1Database component lets you add [Cloudflare D1 Databases](https://developers.cloudflare.com/d1/) to your app. D1 provides serverless SQL databases built on SQLite with automatic data replication.

# Minimal Example

Create a basic D1 database with default settings:

```ts
import { D1Database } from "alchemy/cloudflare";

const database = await D1Database("my-app-db", {
  name: "my-app-db"
});
```

# With Location Hint

Create a database with location hint for optimal performance:

```ts
import { D1Database } from "alchemy/cloudflare";

const westUsDatabase = await D1Database("west-us-db", {
  name: "west-us-db", 
  primaryLocationHint: "wnam"
});
```

# With Read Replication

Configure read replication settings:

```ts
import { D1Database } from "alchemy/cloudflare";

const replicatedDb = await D1Database("replicated-db", {
  name: "replicated-db",
  readReplication: {
    mode: "auto" // Enable automatic read replication
  }
});
```

# Bind to a Worker

Bind a D1 database to a Worker:

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