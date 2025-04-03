# Wrangler Json

The Wrangler Json resource lets you create and manage [Cloudflare Workers configuration files](https://developers.cloudflare.com/workers/wrangler/configuration/) (wrangler.json).

## Minimal Example

Creates a basic wrangler.json configuration file for a Worker.

```ts
import { WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("my-worker-config", {
  name: "my-worker",
  main: "src/index.ts"
});
```

## Create a Worker Configuration

```ts
import { WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("my-worker-config", {
  name: "my-worker",
  main: "src",
  entrypoint: "index.ts",
  minify: true,
  routes: ["example.com/*"],
  vars: {
    API_URL: "https://api.example.com"
  },
  kv_namespaces: [{
    binding: "CACHE",
    id: "xxx"
  }],
  durable_objects: {
    bindings: [{
      name: "COUNTER",
      class_name: "Counter"
    }]
  }
});
```

## Bind to a Worker

```ts
import { Worker, WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("my-worker-config", {
  name: "my-worker",
  main: "src/index.ts"
});

await Worker("my-worker", {
  name: "my-worker",
  entrypoint: "src/index.ts",
  bindings: {
    CONFIG: config
  }
});
```