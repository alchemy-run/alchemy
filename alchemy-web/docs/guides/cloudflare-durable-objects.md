---
order: 5
---

# Durable Object

This guide explains how to create, bind and use Cloudflare Durable Objects within your Worker scripts.

> [!TIP]
> We assume you're familiar with Cloudflare Durable Objects already. If not, read [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/) first.

## Create a Durable Object Namespace

At a bare minimum, you need to create a `DurableObjectNamespace` object as a stable reference to your Durable Object namespace.

```ts
import { DurableObjectNamespace } from "alchemy/cloudflare";

const counter = new DurableObjectNamespace("counter", {
  className: "Counter",
  // whether you want a sqllite db per DO (usually yes!)
  sqlite: true
});
```

If you're paying close attention, you'll notice that we call `new DurableObjectNamespace` instead of `await DurableObjectNamespace` like you might have come to expect from Alchemy Resources.

This is because of oddities in Cloudflare's API design. Durable Object namespaces are not resources in the traditional sense because they cannot exist without a Worker.

## Bind the Durable Object to a Worker

Instead, you create a Durable Object namespace and then bind it to your Worker:

```ts
export const worker = await Worker("Worker", {
  name: "my-worker",
  entrypoint: "./index.ts"
  bindings: {
    // bind the Durable Object namespace to your Worker
    COUNTER: counter,
  },
});
```

## Implement the Durable Object class

Now, we have a Worker with a Durable Object running within it. To use this Durable Object, our Worker script must include a class for the Durable Object and then some code in the `fetch` handler to interact with it.

A simple Durable Object may look like so:

```ts
export class Counter {
  private state: DurableObjectState;
  private count: number;

  constructor(state, env) {
    this.state = state;
    this.count = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Retrieve current count
    this.count = await this.state.storage.get("count") || 0;

    if (path === "/increment") {
      this.count++;
      await this.state.storage.put("count", this.count);
    } else if (path === "/decrement") {
      this.count--;
      await this.state.storage.put("count", this.count);
    }

    return Response.json({ count: this.count });
  }
}
```

> [!TIP]
> See Cloudflare's [Durable Objects Guide](https://developers.cloudflare.com/durable-objects/get-started/) for more details on implementing Durable Objects.

## Access the Durable Object from your Worker

Now, our `fetch` handler can get a Durable Object instance via the `COUNTER` binding:

```ts
import { env } from "cloudflare:workers";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    
    // Create an ID for the Counter (different IDs = different Counter instances)
    const id = env.COUNTER.idFromName("A");
    
    // Get a stub for the Counter instance
    const stub = env.COUNTER.get(id);
    
    // Forward the request to the Durable Object
    return stub.fetch(request);
  },
};
```

## Type-safe Bindings

Remember, for `env.` to be type-safe, you need to configure your `src/env.d.ts` to infer the types from your worker:

```ts
// src/env.d.ts
import type { worker } from "./alchemy.run";

export type WorkerEnv = typeof worker.Env;

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends WorkerEnv {}
  }
}
```

> [!TIP]
> See the [Bindings](../concepts/bindings.md) for more information. 