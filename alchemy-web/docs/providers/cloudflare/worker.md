# Worker

The Worker resource lets you deploy [Cloudflare Workers](https://developers.cloudflare.com/workers/) - serverless JavaScript/TypeScript functions that run on Cloudflare's global network.

## Minimal Example

Create a basic HTTP handler worker:

```ts
import { Worker } from "alchemy/cloudflare";

const worker = await Worker("api", {
  name: "api-worker", 
  script: "addEventListener('fetch', event => event.respondWith(new Response('Hello World')))"
});
```

## Create a Worker with Bindings

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

## Create a Worker with Routes

```ts
import { Worker } from "alchemy/cloudflare";

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts",
  routes: ["api.example.com/*"],
  url: true // Enable workers.dev URL
});
```

## Create a Worker with Environment Variables

```ts
import { Worker } from "alchemy/cloudflare";
import { secret } from "alchemy";

const worker = await Worker("api", {
  name: "api-worker",
  entrypoint: "./src/api.ts",
  bindings: {
    API_KEY: secret(process.env.API_KEY)
  },
  env: {
    NODE_ENV: "production"
  }
});
```