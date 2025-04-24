# Worker

The Worker resource lets you create and manage [Cloudflare Workers](https://developers.cloudflare.com/workers/) - serverless JavaScript functions that run on Cloudflare's edge network.

# Minimal Example

Create a basic HTTP handler worker:

```ts
import { Worker } from "alchemy/cloudflare";

const api = await Worker("api", {
  name: "api-worker", 
  entrypoint: "./src/api.ts"
});
```

# Worker with Bindings

Create a worker with KV namespace and Durable Object bindings:

```ts
import { Worker, KVNamespace, DurableObjectNamespace } from "alchemy/cloudflare";

const cache = await KVNamespace("cache", {
  title: "cache-store"
});

const counter = new DurableObjectNamespace("counter", {
  className: "Counter"
});

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts",
  bindings: {
    CACHE: cache,
    COUNTER: counter
  }
});
```

# Worker with Static Assets

Create a worker that serves static assets:

```ts
import { Worker, Assets } from "alchemy/cloudflare";

const staticAssets = await Assets("static", {
  path: "./dist"
});

const frontend = await Worker("frontend", {
  name: "frontend-worker",
  entrypoint: "./src/worker.ts", 
  bindings: {
    ASSETS: staticAssets
  }
});
```

# Worker with Cron Triggers

Create a worker with scheduled cron triggers:

```ts
import { Worker } from "alchemy/cloudflare";

const cronWorker = await Worker("scheduled-tasks", {
  name: "cron-worker",
  entrypoint: "./src/scheduled.ts",
  crons: ['* 15 * * *', '0 0 * * *'] 
});
```

# Bind to a Worker

Bind a resource to an existing worker:

```ts
import { Worker, KVNamespace } from "alchemy/cloudflare";

const cache = await KVNamespace("cache", {
  title: "cache-store"
});

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts",
  bindings: {
    CACHE: cache
  }
});
```