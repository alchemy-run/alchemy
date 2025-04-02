# Worker

The Worker component allows you to deploy [Cloudflare Workers](https://developers.cloudflare.com/workers/) to the Cloudflare network. Cloudflare Workers are serverless functions that run on Cloudflare's edge network, enabling you to build fast, scalable applications.

# Minimal Example

```ts
import { Worker } from "alchemy/cloudflare";

const myWorker = await Worker("my-worker", {
  name: "my-worker",
  entrypoint: "./src/index.ts",
});
```

# Create the Worker

```ts
import { Worker } from "alchemy/cloudflare";

const myWorker = await Worker("my-worker", {
  name: "my-worker",
  entrypoint: "./src/index.ts",
  routes: ["example.com/*"],
  url: true,
});
```

# Bind to a Worker

```ts
import { Worker, KVNamespace } from "alchemy/cloudflare";

const myKVNamespace = await KVNamespace("my-kv-namespace", {
  title: "my-kv-namespace",
});

const myWorker = await Worker("my-worker", {
  name: "my-worker",
  entrypoint: "./src/index.ts",
  bindings: {
    MY_KV_NAMESPACE: myKVNamespace,
  },
});
```

This documentation provides a concise overview of how to create and bind Cloudflare Workers using the Alchemy IaC library. The examples demonstrate the creation of a worker, setting up routes, enabling a workers.dev URL, and binding a KV Namespace to the worker.