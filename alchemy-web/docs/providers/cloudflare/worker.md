---
title: Managing Cloudflare Workers with Alchemy
description: Learn how to deploy, configure, and manage Cloudflare Workers using Alchemy for serverless functions at the edge.
---

# Worker

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) is a serverless function that runs on Cloudflare's global network.

## Minimal Example

Create a basic HTTP handler worker:

```ts
import { Worker } from "alchemy/cloudflare";

const worker = await Worker("api", {
  name: "api-worker", 
  entrypoint: "./src/api.ts"
});
```

## With Bindings

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

## With Static Assets

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

## With Cron Triggers

Schedule recurring tasks:

```ts
import { Worker } from "alchemy/cloudflare";

const worker = await Worker("cron", {
  name: "cron-worker",
  entrypoint: "./src/cron.ts",
  crons: ["0 0 * * *"] // Run daily at midnight
});
```

## Bind to a Worker

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

## Cross-Script Durable Object Binding

Share durable objects between workers by defining them in one worker and accessing them from another:

```ts
import { Worker, DurableObjectNamespace } from "alchemy/cloudflare";

// Worker that defines and owns the durable object
const dataWorker = await Worker("data-worker", {
  name: "data-worker",
  entrypoint: "./src/data.ts",
  bindings: {
    // Bind to its own durable object
    STORAGE: new DurableObjectNamespace("storage", {
      className: "DataStorage"
    })
  }
});

// Worker that accesses the durable object from another worker
const apiWorker = await Worker("api-worker", {
  name: "api-worker",
  entrypoint: "./src/api.ts", 
  bindings: {
    // Cross-script binding to the data worker's durable object
    SHARED_STORAGE: dataWorker.bindings.STORAGE
  }
});
```

## With Custom Domain Routing

```ts
import { Worker, Route, Zone } from "alchemy/cloudflare";

const zone = await Zone("example-zone", {
  name: "example.com",
  type: "full",
});

const api = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts"
});

const route = await Route("route", {
  zoneId: zone.id,
  worker: api,
  pattern: "api.example.com/*"
});
```