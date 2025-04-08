# Bindings

Bindings allow you to connect resources together in a type-safe way. They are commonly used to connect resources like KV Namespaces and R2 Buckets to Cloudflare Workers.

## What Are Bindings?

Bindings are connections between your Worker code and external resources. They provide a way to access Cloudflare resources like KV Namespaces, R2 Buckets, and Durable Objects directly from your Worker code.

> [!NOTE]
> Bindings are defined during deployment and become available at runtime through the environment object passed to your Worker.

## Binding Resources to Workers

When deploying a Worker, you can bind various Cloudflare resources to make them accessible within your Worker code. Alchemy makes this process type-safe and straightforward.

```typescript
const bucket = await R2Bucket("my-bucket", {
  name: "my-bucket"
});

const worker = await Worker("api", {
  // ... other worker config
  bindings: {
    MY_BUCKET: bucket
  }
});
```

## Supported Binding Types

Alchemy supports binding various Cloudflare resources to your Workers:

1. KV Namespaces for key-value storage
2. R2 Buckets for object storage
3. Durable Objects for stateful applications
4. Secrets for secure environment variables
5. Service bindings for connecting to other Workers

> [!TIP]
> You can bind multiple resources of different types to a single Worker by adding them to the bindings object.

## Type-Safe Bindings

Alchemy provides type safety for your bindings, ensuring you can access them correctly in your Worker code.

1. Create an env.d.ts file to define your environment types:

```typescript
/// <reference types="./env.d.ts" />

import type { api } from "../alchemy.run";

export type CloudFlareEnv = typeof api.Env;

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudFlareEnv {}
  }
}
```

2. Import the env type in your Worker:

```typescript
import { env } from "cloudflare:workers";

export default {
  async fetch(request: Request, env: env) {
    // now we can access the bindings safely
    const file = await env.MY_BUCKET.get("image.jpg");
  }
};
```

> [!NOTE]
> The /// <reference types="@cloudflare/workers-types" /> pragma is required to make the types available globally

## Accessing Bindings at Runtime

Once bound, resources are accessible through the environment object passed to your Worker's handlers.

```typescript
export default {
  async fetch(request: Request, env) {
    // Access KV Namespace
    const value = await env.MY_KV.get("key");
    
    // Access R2 Bucket
    const object = await env.MY_BUCKET.get("file.txt");
    
    // Access Durable Object
    const id = env.MY_DO.newUniqueId();
    const stub = env.MY_DO.get(id);
    
    // Access Secret
    const apiKey = env.MY_SECRET;
    
    return new Response("Success!");
  }
};
```

## Binding Inheritance

Worker bindings are inherited by any Workers that bind to them through service bindings, creating a chain of accessible resources.

> [!TIP]
> This inheritance pattern allows you to create modular Worker architectures where specialized Workers can access only the resources they need.