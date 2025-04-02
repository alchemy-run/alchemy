# Worker

The Worker component allows you to deploy [Cloudflare Workers](https://developers.cloudflare.com/workers/) to the Cloudflare network. Cloudflare Workers are serverless functions that run on Cloudflare's edge network, enabling you to build fast, scalable applications.

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
  bindings: {
    MY_SECRET: "my-secret-value",
  },
  routes: ["example.com/*"],
  url: true,
});
```

# Bind to a Worker

```ts
import { Worker } from "alchemy/cloudflare";

const myResource = await Worker("my-resource", {
  name: "my-resource",
  script: "console.log('Resource initialized')",
});

await Worker("my-worker", {
  name: "my-worker",
  script: "console.log('Hello, world!')",
  bindings: {
    myResource,
  },
});
```