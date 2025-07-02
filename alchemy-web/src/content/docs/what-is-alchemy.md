---
# Top-level doc metadata
order: 0
title: What is Alchemy
description: Alchemy is a TypeScript library that creates and manages cloud infrastructure when you run it.
sidebar:
  order: 0
---

Alchemy is a TypeScript library that creates and manages cloud infrastructure when you run it. Instead of using a CLI or configuration files, you write a regular TypeScript program.

## How it works

```typescript
import alchemy from "alchemy";
import { Worker } from "alchemy/cloudflare";

// Create an app
const app = await alchemy("my-app");

// Create resources
const worker = await Worker("api", {
  entrypoint: "./src/api.ts"
});

// Clean up orphaned resources
await app.finalize();
```

Run it:
```bash
bun ./alchemy.run.ts         # deploy
bun ./alchemy.run.ts --dev   # local development
bun ./alchemy.run.ts --destroy # tear down
```

## Resources

Resources are async functions that create infrastructure. Each resource handles its own lifecycle:

```typescript
// Create a KV namespace
const kv = await KVNamespace("cache", {
  title: "My Cache"
});

// Create a worker with the KV binding
const worker = await Worker("api", {
  entrypoint: "./src/worker.ts",
  bindings: {
    CACHE: kv
  }
});
```

## State

Alchemy tracks what it creates in `.alchemy/` directory:

```
.alchemy/
  my-app/
    dev/
      cache.json
      api.json
```

Each file contains the resource's current state. If you run the script again, Alchemy compares the desired state with the actual state and updates only what changed.

## Phases

Your script can run in three phases:

- **up** (default) - Create, update, or delete resources
- **read** - Read existing resources without changes
- **destroy** - Delete all resources

```typescript
const app = await alchemy("my-app", {
  phase: "destroy" // or pass --destroy flag
});
```

## Scopes

Resources are organized in scopes - like folders for your infrastructure:

```typescript
const app = await alchemy("my-app"); // app scope

// Resources here are in the app/dev scope
const db = await Database("main");

// Create a nested scope
await alchemy.run("backend", async () => {
  // Resources here are in app/dev/backend scope
  const api = await Worker("api");
});
```

## Bindings

Connect resources together:

```typescript
const kv = await KVNamespace("data");
const queue = await Queue("tasks");

const worker = await Worker("processor", {
  entrypoint: "./processor.ts",
  bindings: {
    DATA: kv,      // KV namespace binding
    TASKS: queue,  // Queue binding
    API_KEY: alchemy.secret(process.env.API_KEY) // Secret
  }
});
```

## Development Mode

Run locally with hot reloading:

```bash
bun ./alchemy.run.ts --dev
```

Resources can run locally or connect to remote services:

```typescript
const db = await D1Database("app-db", {
  dev: { remote: true } // Use real D1 in dev mode
});
```

## Testing

Test resources in isolation:

```typescript
import { alchemy, destroy } from "alchemy";
import "alchemy/test/vitest";

const test = alchemy.test(import.meta);

test("create worker", async (scope) => {
  const worker = await Worker("test-worker", {
    script: "export default { fetch() { return new Response('ok') } }"
  });
  
  expect(worker.url).toBeTruthy();
  
  // Cleanup
  await destroy(scope);
});
```

## Available Providers

- **Cloudflare**: Worker, KV, R2, D1, Queue, Durable Objects
- **AWS**: S3, DynamoDB, Lambda, ECS, VPC
- **Others**: Docker, GitHub, Stripe, Vercel, Neon, PlanetScale

## Next Steps

- [Getting Started](../getting-started.mdx) - Deploy your first worker
- [Concepts](../concepts/resource.mdx) - Deep dive into how Alchemy works
- [Guides](../guides/cloudflare-worker.mdx) - Build real applications

Happy transmutation! ✨
