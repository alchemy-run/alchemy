# Worker

The Worker component allows you to deploy [Cloudflare Workers](https://developers.cloudflare.com/workers/) to the Cloudflare network. Cloudflare Workers are serverless functions that can be used to build scalable applications with global distribution.

# Minimal Example

```ts
import { Worker } from "alchemy/cloudflare";

const myWorker = await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
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
  script: "console.log('Hello, world!')",
  bindings: {
    MY_KV_NAMESPACE: myKVNamespace,
  },
});
```