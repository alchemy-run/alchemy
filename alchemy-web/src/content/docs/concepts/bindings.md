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

Alchemy supports three main categories of bindings:

### Strings (Public Information)

String bindings are for non-sensitive configuration values that can be safely visible in logs, console output, and deployed code. These are perfect for environment indicators, feature flags, or public configuration.

```typescript
const worker = await Worker("my-worker", {
  name: "my-worker",
  entrypoint: "./src/worker.ts",
  bindings: {
    STAGE: app.stage,              // Environment stage (dev, staging, prod)
    VERSION: "1.0.0",              // Application version
    DEBUG_MODE: "true",            // Feature flag
    API_BASE_URL: "https://api.example.com"  // Public API endpoint
  }
});
```

**Important**: String bindings are visible in:
- Console logs and debugging output
- Deployed worker code
- Cloudflare dashboard
- Any error messages or stack traces

### Secrets (Sensitive Information)

Secret bindings are for sensitive values like API keys, passwords, tokens, and other credentials. These must always be wrapped in `alchemy.secret()` to ensure secure handling.

```typescript
const worker = await Worker("my-worker", {
  name: "my-worker",
  entrypoint: "./src/worker.ts",
  bindings: {
    API_KEY: alchemy.secret("secret-key"),           // API key from environment
    DATABASE_PASSWORD: alchemy.secret("db-pass"),   // Database password
    JWT_SECRET: alchemy.secret("jwt-secret"),        // JWT signing secret
    WEBHOOK_SECRET: alchemy.secret("webhook-key")    // Webhook verification key
  }
});
```

**Security features**:
- Values are encrypted at rest
- Not visible in logs or console output
- Redacted in error messages
- Secure transmission to workers

### Resources (Infrastructure)

Resource bindings connect your worker to other Alchemy-managed infrastructure like storage, databases, and services. These create typed bindings with full API access.

```typescript
import { Worker, KVNamespace, R2Bucket, DurableObject } from "alchemy/cloudflare";

// Create resources
const kvStore = await KVNamespace("MY_KV", { title: "my-kv-namespace" });
const bucket = await R2Bucket("MY_BUCKET", { name: "my-storage-bucket" });
const counter = await DurableObject("COUNTER", { script: "./src/counter.ts" });

const worker = await Worker("my-worker", {
  name: "my-worker",
  entrypoint: "./src/worker.ts",
  bindings: {
    // Infrastructure resources
    KV_STORE: kvStore,     // Full KV namespace API
    STORAGE: bucket,       // Full R2 bucket API
    COUNTER: counter,      // Durable object instance
    
    // Mixed with other binding types
    STAGE: app.stage,      // String
    API_KEY: alchemy.secret("key")  // Secret
  }
});
```

**Resource binding types**:
- **KV Namespace**: Key-value storage with `get()`, `put()`, `delete()` methods
- **R2 Bucket**: Object storage with `get()`, `put()`, `delete()`, `list()` methods
- **Durable Object**: Stateful objects with custom APIs
- **Queue**: Message queues with `send()`, `sendBatch()` methods
- **Database**: SQL databases with query capabilities

## How Bindings Work

Alchemy automatically configures bindings based on their type:

- **Resources**: Automatically provisioned and connected in Cloudflare
- **Secrets**: Encrypted and securely injected as environment variables
- **Strings**: Passed as plain environment variables

```typescript
const worker = await Worker("worker", {
  // ...
  bindings: {
    // Resources: Automatically set up in Cloudflare
    KV_STORE: kvNamespace,
    COUNTER: durableObject,
    BUCKET: r2Bucket,
    
    // Secrets: Encrypted environment variables
    API_KEY: alchemy.secret(process.env.API_KEY),
    
    // Strings: Plain environment variables
    STAGE: app.stage,
    DEBUG: "true",
    VERSION: "1.0.0"
  }
});
```
