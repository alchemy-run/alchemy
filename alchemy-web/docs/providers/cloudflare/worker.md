# Worker

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) is a serverless function that runs on Cloudflare's global network. Workers can handle HTTP requests, manipulate responses, and interact with other Cloudflare services.

# Minimal Example

Create a basic HTTP handler worker:

```ts
import { Worker } from "alchemy/cloudflare";

const api = await Worker("api", {
  name: "api-worker", 
  script: `
    export default {
      async fetch(request) {
        return new Response("Hello World!");
      }
    }
  `
});
```

# Create a Worker with Bindings

Bind KV namespaces, Durable Objects, and other resources to a worker:

```ts
import { Worker, KVNamespace, DurableObjectNamespace } from "alchemy/cloudflare";

const kv = await KVNamespace("data", {
  title: "data-store"
});

const counter = new DurableObjectNamespace("counter", {
  className: "Counter"
});

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts",
  bindings: {
    DATA: kv,
    COUNTER: counter
  }
});
```

# Create a Worker with Routes

Configure custom domain routing and enable workers.dev URL:

```ts
import { Worker } from "alchemy/cloudflare";

const api = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts",
  routes: ["api.example.com/*"],
  url: true // Enables workers.dev URL
});

console.log(api.url); // https://api-worker.username.workers.dev
```