# Wrangler Json

The Wrangler Json resource lets you create and manage [wrangler.json configuration files](https://developers.cloudflare.com/workers/wrangler/configuration/) for Cloudflare Workers.

# Minimal Example

Create a basic wrangler.json file with minimal configuration:

```ts
import { WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("my-worker-config", {
  name: "my-worker",
  main: "src/index.ts"
});
```

# Create a Full Configuration

Create a wrangler.json with multiple bindings and settings:

```ts
import { WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("my-worker-config", {
  name: "my-worker",
  main: "src",
  entrypoint: "index.ts",
  minify: true,
  node_compat: true,
  vars: {
    API_URL: "https://api.example.com"
  },
  kv_namespaces: [{
    binding: "CACHE",
    id: "xxx"
  }],
  r2_buckets: [{
    binding: "STORAGE",
    bucket_name: "my-bucket"
  }],
  durable_objects: {
    bindings: [{
      name: "COUNTER",
      class_name: "Counter"
    }]
  },
  routes: ["example.com/*"],
  triggers: {
    crons: ["0 0 * * *"]
  }
});
```