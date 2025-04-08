---
order: 3
---

# Durable Objects & Migrations

This guide is Part 3 in our Cloudflare and Alchemy series. We'll add Durable Objects to our application.

**Previous Tutorial**: [Cloudflare Worker with KV Storage](./worker.md) (Part 2)  
**Next Tutorial**: [Setting up Cloudflare Zones](./zone.md) (Part 4)

## Creating a Durable Object Class

Create a simple Counter Durable Object:

```typescript
// api/index.ts
export class Counter {
  private state: DurableObjectState;
  private count: number = 0;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
  }

  // Initialize from storage
  async initialize() {
    this.count = await this.state.storage.get("count") || 0;
  }

  // Handle requests
  async fetch(request: Request) {
    // Make sure we're initialized
    if (this.count === undefined) {
      await this.initialize();
    }

    // Increment counter
    this.count++;
    await this.state.storage.put("count", this.count);
    
    // Return the current count
    return new Response(this.count.toString());
  }
}
```

## Adding the Worker Handler

Add a request handler that forwards requests to the Durable Object:

```typescript
// api/index.ts (continued)
export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    // Get a reference to the Counter with a stable ID
    const id = env.COUNTER.idFromName("my-counter");
    const counter = env.COUNTER.get(id);
    
    // Forward the request to the Durable Object
    return counter.fetch(request);
  }
};
```

## Adding the Durable Object Namespace

Update your `alchemy.run.ts` file:

```typescript
import { DurableObjectNamespace } from "alchemy/cloudflare";

export const counter = new DurableObjectNamespace("COUNTER", {
  className: "Counter",
});
```

## Binding the Durable Object

Bind the Durable Object to your worker:

```typescript
// Create worker with the Durable Object binding
export const api = await Worker("api", {
  name: "my-cloudflare-app-api",
  entrypoint: "./api/index.ts",
  bindings: {
    COUNTER: counter,
  },
});
```

## Automatic Class Name Migrations

Alchemy handles Durable Object class name changes automatically. If you rename your class:

```typescript
// Before: api/index.ts
export class Counter {
  // Original implementation
}

// After: api/index.ts
export class AdvancedCounter {
  // Updated implementation
}
```

Update your namespace configuration:

```typescript
// Before:
export const counter = await DurableObjectNamespace("COUNTER", {
  className: "Counter",
  sqlite: true,
});

// After:
export const counter = await DurableObjectNamespace("COUNTER", {
  className: "AdvancedCounter", // Updated class name
  sqlite: true,
});
```

When deployed, Alchemy:
1. Detects the class name change
2. Creates a migration
3. Preserves existing state
4. Routes requests to the new implementation

## Using the Durable Object in React

Add this to your `src/App.tsx`:

```typescript
// Increment the counter
const response = await fetch('/api/counter');
const count = await response.text();
```

## Deploy Your App

Deploy the app with:

```bash
bun ./alchemy.run.ts
```
