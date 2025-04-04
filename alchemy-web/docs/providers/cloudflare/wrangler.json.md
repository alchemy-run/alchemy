# Wrangler Json

The WranglerJson resource lets you create and manage [Cloudflare Workers configuration files](https://developers.cloudflare.com/workers/wrangler/configuration/) (wrangler.json).

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
  outdir: "dist",
  minify: true,
  node_compat: false,
  compatibility_date: "2023-01-01",
  routes: ["example.com/*"],
  vars: {
    API_URL: "https://api.example.com"
  },
  kv_namespaces: [{
    binding: "CACHE",
    id: "xxx"
  }]
});
```

## Configure with Durable Objects

```ts
import { WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("chat-worker-config", {
  name: "chat-worker",
  main: "src/index.ts",
  durable_objects: {
    bindings: [{
      name: "ROOMS",
      class_name: "ChatRoom"
    }]
  }
});
```