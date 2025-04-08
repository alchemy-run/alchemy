# Wrangler Json

The WranglerJson resource lets you create and manage [wrangler.json configuration files](https://developers.cloudflare.com/workers/wrangler/configuration/) for Cloudflare Workers.

# Minimal Example

Create a basic wrangler.json file with minimal configuration:

```ts
import { WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("my-worker-config", {
  name: "my-worker",
  main: "src/index.ts"
});
```

# Create with Advanced Configuration

Create a wrangler.json with custom settings and bindings:

```ts
import { WranglerJson } from "alchemy/cloudflare";

const config = await WranglerJson("my-worker-config", {
  name: "my-worker",
  main: "src/index.ts",
  outdir: "dist",
  minify: true,
  node_compat: true,
  compatibility_date: "2023-01-01",
  kv_namespaces: [
    {
      binding: "MY_KV",
      id: "xxx",
      preview_id: "yyy"
    }
  ],
  r2_buckets: [
    {
      binding: "MY_BUCKET", 
      bucket_name: "my-bucket"
    }
  ],
  routes: ["example.com/*"],
  triggers: {
    crons: ["0 0 * * *"]
  }
});
```