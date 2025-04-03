# Worker

The Worker component allows you to deploy [Cloudflare Workers](https://developers.cloudflare.com/workers/) to the Cloudflare network, enabling serverless functions with global distribution and caching.

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

const apiWorker = await Worker("api-worker", {
  name: "api-worker",
  entrypoint: "./src/api.ts",
  routes: ["api.example.com/*"],
  url: true,
});
```

# Bind to a Worker

```ts
import { Worker, KVNamespace } from "alchemy/cloudflare";

const myKVNamespace = await KVNamespace("my-kv", {
  title: "my-kv-namespace",
});

const myWorker = await Worker("my-worker", {
  name: "my-worker",
  entrypoint: "./src/index.ts",
  bindings: {
    MY_KV: myKVNamespace,
  },
});
```