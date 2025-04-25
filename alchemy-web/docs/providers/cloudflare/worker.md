# Worker

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) is a serverless function that runs on Cloudflare's global network.

# Minimal Example

Create a basic HTTP handler worker:

```ts
import { Worker } from "alchemy/cloudflare";

const worker = await Worker("api", {
  name: "api-worker", 
  entrypoint: "./src/api.ts"
});
```

# With Bindings

Attach resources like KV, R2, or Durable Objects:

```ts
import { Worker, KVNamespace, DurableObjectNamespace } from "alchemy/cloudflare";

const kv = await KVNamespace("cache", { title: "cache-store" });
const users = new DurableObjectNamespace("users", { className: "Users" });

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts",
  bindings: {
    CACHE: kv,
    USERS: users
  }
});
```

# With Static Assets

Serve static files from a directory:

```ts
import { Worker, Assets } from "alchemy/cloudflare";

const assets = await Assets("static", {
  path: "./public"
});

const worker = await Worker("frontend", {
  name: "frontend-worker", 
  entrypoint: "./src/worker.ts",
  bindings: {
    ASSETS: assets
  }
});
```

# With Cron Triggers

Schedule recurring tasks:

```ts
import { Worker } from "alchemy/cloudflare";

const worker = await Worker("cron", {
  name: "cron-worker",
  entrypoint: "./src/cron.ts",
  crons: ["0 0 * * *"] // Run daily at midnight
});
```

# Bind to a Worker

Use a worker as a binding in another worker:

```ts
import { Worker } from "alchemy/cloudflare";

const api = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts"
});

const frontend = await Worker("frontend", {
  name: "frontend-worker",
  entrypoint: "./src/frontend.ts",
  bindings: {
    API: api
  }
});
```