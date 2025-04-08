---
order: 2
---

# Workers and Bindings

This guide is Part 2 in our Cloudflare and Alchemy series. We'll add a Cloudflare Worker with KV storage to our Vite.js app.

**Previous Tutorial**: [Cloudflare and Vite.js Integration](./vitejs.md) (Part 1)

## Creating a KV Namespace

First, let's create a KV namespace in `alchemy.run.ts`:

```typescript
// Import KVNamespace
import { KVNamespace } from "alchemy/cloudflare";

// Create a KV namespace
export const dataStore = await KVNamespace("DATA_STORE", {
  title: "my-app-data-store",
  // Initialize with a counter value
  values: [{ key: "counter", value: "0" }]
});
```

This creates a KV namespace named "my-app-data-store" with an initial counter value.

## Creating a Simple Worker

Create a minimal worker that reads and writes to KV:

```typescript
// api/index.ts
export default {
  async fetch(request: Request, env: any) {
    // Get the current counter value
    const value = await env.DATA_STORE.get("counter") || "0";
    
    // Increment the counter
    const newValue = (parseInt(value) + 1).toString();
    await env.DATA_STORE.put("counter", newValue);
    
    // Return the new value
    return new Response(newValue);
  }
};
```

This worker simply:
1. Reads the "counter" value from KV
2. Increments it by 1
3. Saves it back to KV
4. Returns the new value

## Bind the KV Namespace to your Worker

Connect the worker to the KV namespace in `alchemy.run.ts`:

```typescript
// Create a worker with the KV namespace binding
export const api = await Worker("api", {
  name: "my-cloudflare-app-api",
  entrypoint: "./api/index.ts",
  bindings: {
    // This gives the worker access to the KV namespace
    DATA_STORE: dataStore
  }
});
```

## Adding Type-Safe Bindings

To make your worker type-safe, create an `env.d.ts` file:

```typescript
// env.d.ts
import type { api } from "./alchemy.run";

export type WorkerEnv = typeof api.Env;

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends WorkerEnv {}
  }
}
```

Now update your worker to use the typed environment:

```typescript
// api/index.ts
export default {
  async fetch(request: Request, env: WorkerEnv) {
    // env.DATA_STORE is now fully typed with get(), put(), etc.
    const value = await env.DATA_STORE.get("counter") || "0";
    // ...
  }
};
```

Or, use Cloudflare's new global `env` import

```ts
import { env } from "cloudflare:workers";

env.DATA_STORE // is safely KVNamespace
```

> [!NOTE]
> Learn more about how bindings work in our [Concepts: Bindings](../../concepts/bindings.md).


## Connecting the Worker to Your Site

Route API requests to your worker:

```typescript
// Update the StaticSite to route API requests to the worker
export const website = await StaticSite("Website", {
  name: "my-cloudflare-app",
  dir: "./dist",
  build: {
    command: "bun run build",
  },
  routes: {
    // configure the StaticSite router worker to route /api/* to our worker
    "/api/*": api
  }
});
```

## Creating a Simple Counter UI

Update your React app to use the counter:

```tsx
// src/App.tsx
import { useState, useEffect } from 'react'

function App() {
  const [count, setCount] = useState<string>("0");

  // Increment counter function
  const incrementCounter = async () => {
    const response = await fetch('/api/counter');
    const newCount = await response.text();
    setCount(newCount);
  };

  // Load the counter on page load
  useEffect(() => {
    incrementCounter();
  }, []);

  return (
    <div className="App">
      <h1>KV Counter: {count}</h1>
      <button onClick={incrementCounter}>
        Increment
      </button>
    </div>
  )
}

export default App
```

## Deploy Your App

Deploy everything with one command:

```bash
bun ./alchemy.run.ts
```

Visit your app to see the counter increment each time you refresh or click the button.

