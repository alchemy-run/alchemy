---
title: Binding
description: Connect your infrastructure resources with type-safe bindings. Learn how to bind KV namespaces, Durable Objects, R2 buckets, and environment variables to Cloudflare Workers.
sidebar:
  order: 4.1
---

Bindings allow resources to connect to each other in a type-safe way. In Alchemy, bindings are most commonly used with Cloudflare Workers to give them access to other resources.

## What are Bindings?

Bindings expose resources to your code at runtime. For example, they allow a Cloudflare Worker to access:

- KV Namespaces
- Durable Objects
- R2 Buckets
- Secrets and variables

## Using Bindings in Workers

:::caution
Sensitive values like API keys, passwords, and tokens must not be passed as plain strings. Always wrap them in `alchemy.secret()` to ensure they are handled securely.
:::

```typescript
// alchemy.run.ts
import { Worker, KVNamespace } from "alchemy/cloudflare";

// Create a KV namespace
const myKV = await KVNamespace("MY_KV", {
  title: "my-kv-namespace"
});

// Bind the KV namespace to a worker
const myWorker = await Worker("my-worker", {
  name: "my-worker",
  entrypoint: "./src/worker.ts",
  bindings: {
    MY_KV: myKV,
    API_KEY: alchemy.secret("secret-key"),
    DEBUG_MODE: true
  }
});
```

The worker can then access these bindings through the `env` parameter:

```typescript
// src/worker.ts
export default {
  async fetch(request: Request, env: any, ctx: any) {
    // Access the KV namespace binding
    const value = await env.MY_KV.get("key");
    
    // Access other bindings
    const apiKey = env.API_KEY;
    const isDebug = env.DEBUG_MODE;
    
    return new Response(`Value: ${value}`);
  }
};
```

## Type-Safe Bindings

To make bindings type-safe, create an `env.ts` file:

```typescript
import type { myWorker } from "./alchemy.run";

export type WorkerEnv = typeof myWorker.Env;

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends WorkerEnv {}
  }
}
```

Register `env.ts` in your `tsconfig.json`'s `types`.
```json
{
  "compilerOptions": {
    "types": ["@cloudflare/workers-types", "./src/env.ts"]
  }
}
```

Then, use the type in your worker:

```typescript
// src/worker.ts
export default {
  async fetch(request: Request, env: WorkerEnv, ctx: any) {
    // Type-safe access to bindings
    const value = await env.MY_KV.get("key");
    const apiKey = env.API_KEY;
    
    return new Response(`Value: ${value}`);
  }
};
```

Or use the global import:
```ts
import { env } from "cloudflare:workers";

await env.MY_KV.get("key")
```

## Binding Types

Alchemy supports three types of bindings:

### Strings
For non-sensitive configuration values (visible in logs):

```typescript
const worker = await Worker("my-worker", {
  bindings: {
    STAGE: app.stage,
    VERSION: "1.0.0",
    DEBUG_MODE: "true"
  }
});
```

### Secrets
For sensitive values like API keys (always use `alchemy.secret()`):

```typescript
const worker = await Worker("my-worker", {
  bindings: {
    API_KEY: alchemy.secret("secret-key"),
    DATABASE_PASSWORD: alchemy.secret("db-pass")
  }
});
```

### Resources
For infrastructure connections:

```typescript
import { Worker, KVNamespace, R2Bucket } from "alchemy/cloudflare";

const kvStore = await KVNamespace("MY_KV", { title: "my-kv-namespace" });
const bucket = await R2Bucket("MY_BUCKET", { name: "my-storage-bucket" });

const worker = await Worker("my-worker", {
  bindings: {
    KV_STORE: kvStore,
    STORAGE: bucket,
    STAGE: app.stage,
    API_KEY: alchemy.secret("key")
  }
});
```
