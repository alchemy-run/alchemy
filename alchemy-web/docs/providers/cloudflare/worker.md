# Worker

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) is a serverless function that runs on Cloudflare's global network. Workers can handle HTTP requests, process data, and interact with other Cloudflare services.

# Minimal Example

Create a basic HTTP handler worker:

```ts
import { Worker } from "alchemy/cloudflare";

const api = await Worker("api", {
  name: "api-worker", 
  entrypoint: "./src/api.ts",
  url: true // Enable workers.dev URL
});
```

# Worker with Bindings

Bind to KV, R2, Durable Objects and other Cloudflare services:

```ts
import { Worker, KVNamespace, DurableObjectNamespace } from "alchemy/cloudflare";

const kv = await KVNamespace("cache", {
  title: "cache-store"
});

const counter = new DurableObjectNamespace("counter", {
  className: "Counter"
});

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts",
  bindings: {
    CACHE: kv,
    COUNTER: counter
  }
});
```

# Worker with Static Assets

Serve static assets from a directory:

```ts
import { Worker, Assets } from "alchemy/cloudflare";

const assets = await Assets("static", {
  path: "./dist"
});

const site = await Worker("website", {
  name: "website-worker",
  entrypoint: "./src/worker.ts",
  bindings: {
    ASSETS: assets
  }
});
```

# Worker with Environment Variables

Add environment variables and secrets:

```ts
import { Worker } from "alchemy/cloudflare";
import { alchemy } from "alchemy";

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts",
  bindings: {
    API_KEY: alchemy.secret(process.env.API_KEY),
    DEBUG: "true"
  }
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